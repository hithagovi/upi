"""
FraudWatch Backend - server.py
-------------------------------
Local dev:   uvicorn server:app --reload --port 8000
Production:  gunicorn server:app -w 2 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:$PORT
"""

from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File, Depends, Form
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pathlib import Path
import os, io, uuid, logging, math
from datetime import datetime, timedelta, timezone
from typing import Optional

import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder, StandardScaler
from sklearn.metrics import precision_score, recall_score, f1_score, roc_auc_score, accuracy_score
from imblearn.over_sampling import SMOTE
from jose import jwt, JWTError
from passlib.context import CryptContext
from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError
from dotenv import load_dotenv

# ── Load .env ─────────────────────────────────────────────────────────────────
load_dotenv()

MONGO_URI        = os.getenv("MONGO_URI", "mongodb://localhost:27017")
DB_NAME          = os.getenv("DB_NAME", "fraudwatch")
JWT_SECRET       = os.getenv("JWT_SECRET", "change-this-in-production")
JWT_ALGO         = "HS256"
JWT_EXPIRE_HOURS = int(os.getenv("JWT_EXPIRE_HOURS", "24"))
FRONTEND_URL     = os.getenv("FRONTEND_URL", "*")
PORT             = int(os.getenv("PORT", "8000"))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── MongoDB ───────────────────────────────────────────────────────────────────
mongo_client     = MongoClient(MONGO_URI)
mdb              = mongo_client[DB_NAME]
users_col        = mdb["users"]
datasets_col     = mdb["datasets"]
transactions_col = mdb["transactions"]
blocks_col       = mdb["blocks"]
users_col.create_index("email", unique=True)
transactions_col.create_index("dataset_id")

# ── Password hashing ──────────────────────────────────────────────────────────
try:
    pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
    pwd_ctx.hash("test")
except Exception as _e:
    logger.warning(f"bcrypt unavailable ({_e}), using sha256_crypt")
    pwd_ctx = CryptContext(schemes=["sha256_crypt"], deprecated="auto")

# ── JWT helpers ───────────────────────────────────────────────────────────────
security = HTTPBearer()

def create_token(email: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRE_HOURS)
    return jwt.encode({"email": email, "exp": exp}, JWT_SECRET, algorithm=JWT_ALGO)

def get_current_user(creds: HTTPAuthorizationCredentials = Depends(security)):
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALGO])
        email = payload.get("email")
        user = users_col.find_one({"email": email}, {"_id": 0, "password": 0})
        if not user:
            raise HTTPException(401, "User not found")
        return user
    except JWTError:
        raise HTTPException(401, "Invalid or expired token")


def bson_safe(value):
    if value is None:
        return None

    if isinstance(value, np.generic):
        value = value.item()

    if isinstance(value, pd.Timestamp):
        if pd.isna(value):
            return None
        return value.to_pydatetime()

    if isinstance(value, np.datetime64):
        if np.isnat(value):
            return None
        return pd.to_datetime(value).to_pydatetime()

    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return float(value)

    if isinstance(value, (list, tuple)):
        return [bson_safe(v) for v in value]

    if isinstance(value, dict):
        return {str(k): bson_safe(v) for k, v in value.items()}

    if isinstance(value, (str, int, bool, datetime)):
        return value

    return str(value)

# ── Fraud heuristics ──────────────────────────────────────────────────────────
AMT_COLS  = ["amount", "Amount", "AMOUNT", "Amount (INR)", "Amount ", "transaction_amount"]
TYPE_COLS = ["type", "Type", "transaction_type", "payment_type"]

def compute_stats(df):
    df.columns = df.columns.str.strip()
    col = next((c for c in AMT_COLS if c.strip() in df.columns), None)
    if col:
        vals = pd.to_numeric(df[col.strip()], errors="coerce").fillna(0)
        return {"avg": float(vals.mean()), "std": float(vals.std() or 1)}
    return {"avg": 0, "std": 1}

def detect_fraud_row(row, stats):
    score, flags = 0, []
    # Strip all keys to handle trailing spaces in column names
    row = {k.strip(): v for k, v in row.items()}

    col = next((c.strip() for c in AMT_COLS if c.strip() in row), None)
    amount = float(row.get(col, 0) or 0) if col else 0

    if stats["std"] > 0:
        z = (amount - stats["avg"]) / stats["std"]
        if z > 3:     score += 35; flags.append("Extremely high amount")
        elif z > 2:   score += 20; flags.append("Unusually high amount")
        elif z > 1.5: score += 10; flags.append("Above-average amount")

    if amount > 100000: score += 15; flags.append("Amount > ₹1 Lakh")
    if amount > 500000: score += 10; flags.append("Amount > ₹5 Lakh")

    tc = next((c.strip() for c in TYPE_COLS if c.strip() in row), None)
    if tc and str(row.get(tc, "")).upper() in ["TRANSFER", "CASH_OUT", "WITHDRAWAL"]:
        score += 15; flags.append(f"High-risk type: {row[tc]}")

    old = float(row.get("oldbalanceOrg", row.get("old_balance", row.get("balance_before", 0))) or 0)
    new = float(row.get("newbalanceOrig", row.get("new_balance", row.get("balance_after", 0))) or 0)
    if old > 0 and new == 0:
        score += 25; flags.append("Account drained to zero")

    ts = str(row.get("Timestamp", row.get("timestamp", row.get("time", ""))))
    if " " in ts:
        try:
            hr = int(ts.split(" ")[1].split(":")[0])
            if 0 <= hr <= 5:  score += 25; flags.append("Late night (12AM-5AM)")
            elif hr >= 22:    score += 10; flags.append("Late evening")
        except Exception:
            pass

    device = str(row.get("device_type", row.get("device", ""))).lower()
    if device == "mobile":
        score += 5; flags.append("Mobile transaction")

    known = row.get("is_fraud", row.get("isFraud", row.get("fraud", row.get("Class", row.get("label", -1)))))
    if str(known).strip() == "1":
        score = max(score, 80); flags.insert(0, "Flagged in dataset")

    score = min(score, 99)
    status = "Fraudulent" if score >= 60 else "Suspicious" if score >= 30 else "Safe"
    return {"score": score, "status": status, "flags": flags, "amount_inr": amount}

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="FraudWatch API", version="2.0.0")
router = APIRouter(prefix="/api")

@app.get("/")
def root():
    return {"status": "FraudWatch API running", "version": "2.0.0"}

@app.get("/health")
def health():
    return {"status": "ok"}

# ── Auth ──────────────────────────────────────────────────────────────────────
class RegisterIn(BaseModel):
    email: str
    password: str
    name: str
    role: str = "analyst"

class LoginIn(BaseModel):
    email: str
    password: str

@router.post("/auth/register")
def register(data: RegisterIn):
    try:
        doc = {
            "id": str(uuid.uuid4()), "email": data.email, "name": data.name,
            "role": data.role, "password": pwd_ctx.hash(data.password),
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        users_col.insert_one({**doc})
        doc.pop("password"); doc.pop("_id", None)
        return {"token": create_token(data.email), "user": doc}
    except DuplicateKeyError:
        raise HTTPException(400, "Email already registered")
    except Exception as e:
        logger.error(f"Register error: {e}", exc_info=True)
        raise HTTPException(500, f"Register failed: {str(e)}")

@router.post("/auth/login")
def login(data: LoginIn):
    try:
        user = users_col.find_one({"email": data.email})
        if not user or not pwd_ctx.verify(data.password, user["password"]):
            raise HTTPException(401, "Invalid credentials")
        user.pop("password"); user.pop("_id", None)
        return {"token": create_token(data.email), "user": user}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Login error: {e}", exc_info=True)
        raise HTTPException(500, f"Login failed: {str(e)}")

@router.get("/auth/me")
def me(user=Depends(get_current_user)):
    return user

# ── Datasets ──────────────────────────────────────────────────────────────────
@router.post("/datasets/upload")
async def upload_dataset(
    file: UploadFile = File(...),
    fraud_column: str = Form("is_fraud"),
    user=Depends(get_current_user)
):
    raw = await file.read()
    try:
        df = pd.read_csv(io.BytesIO(raw))
    except Exception as e:
        raise HTTPException(400, f"Cannot parse CSV: {e}")

    df.columns = df.columns.str.strip()
    possible  = ["isFraud", "is_fraud", "fraud", "Class", "label", fraud_column]
    fraud_col = next((c for c in possible if c in df.columns), None)
    dataset_id = str(uuid.uuid4())

    meta = {
        "id": dataset_id, "filename": file.filename,
        "uploaded_by": user["email"],
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "rows": len(df), "columns": df.columns.tolist(),
        "fraud_column": fraud_col or "none", "status": "uploaded",
        "csv_data": df.to_csv(index=False)
    }
    datasets_col.insert_one(meta)
    meta.pop("_id", None); meta.pop("csv_data", None)
    return meta

@router.get("/datasets")
def list_datasets(user=Depends(get_current_user)):
    return list(datasets_col.find({"uploaded_by": user["email"]}, {"_id": 0, "csv_data": 0}))

# ── Train ─────────────────────────────────────────────────────────────────────
@router.post("/datasets/{dataset_id}/train")
def train_model(dataset_id: str, user=Depends(get_current_user)):
    ds = datasets_col.find_one({"id": dataset_id}, {"_id": 0})
    if not ds:
        raise HTTPException(404, "Dataset not found")
    if not ds.get("csv_data"):
        raise HTTPException(404, "Dataset file missing")

    df = pd.read_csv(io.StringIO(ds["csv_data"]))
    df.columns = df.columns.str.strip()  # Fix trailing spaces in column names
    datasets_col.update_one({"id": dataset_id}, {"$set": {"status": "training"}})

    fraud_col = ds.get("fraud_column", "none")
    if fraud_col not in df.columns:
        fraud_col = next(
            (c for c in ["is_fraud", "isFraud", "fraud", "Class", "label"] if c in df.columns),
            "none"
        )
    has_labels = fraud_col != "none" and fraud_col in df.columns

    # Always drop ALL known fraud label columns to prevent data leakage
    label_cols = ["is_fraud", "isFraud", "fraud", "Class", "label", "Fraud", "TARGET", "target"]
    cols_to_drop = [c for c in label_cols if c in df.columns]
    X = df.drop(columns=cols_to_drop)
    encoders = {}
    for col in X.select_dtypes(include="object").columns:
        le = LabelEncoder()
        X[col] = le.fit_transform(X[col].astype(str))
        encoders[col] = le
    X = X.fillna(X.mean(numeric_only=True))
    feature_cols = X.columns.tolist()
    stats = compute_stats(df)

    # ── Heuristic pass ────────────────────────────────────────────────────────
    results = []
    for i, row in enumerate(df.to_dict("records")):
        det = detect_fraud_row(row, stats)
        r = {str(k): bson_safe(v) for k, v in row.items()}
        r.update({
            "row_id": i,
            "_score": det["score"],
            "_status": det["status"],
            "_flags": det["flags"],
            "_amount_inr": det["amount_inr"],
            "_source": "heuristic",
            "dataset_id": dataset_id,
        })
        results.append(r)

    # ── XGBoost pass ─────────────────────────────────────────────────────────
    metrics, feature_importance = {}, {}
    if has_labels:
        try:
            y = df[fraud_col].astype(int)
            X_arr = X.values
            X_tr, X_te, y_tr, y_te = train_test_split(
                X_arr, y, test_size=0.2, stratify=y, random_state=42)
            if y_tr.sum() > 1:
                X_tr, y_tr = SMOTE(random_state=42).fit_resample(X_tr, y_tr)
            scaler = StandardScaler()
            X_tr = scaler.fit_transform(X_tr)
            X_te  = scaler.transform(X_te)

            model = xgb.XGBClassifier(
                n_estimators=100,
                eval_metric="logloss",
                random_state=42
            )
            model.fit(X_tr, y_tr)
            preds = model.predict(X_te)
            probs = model.predict_proba(X_te)[:, 1]

            metrics = {
                "accuracy":  round(float(accuracy_score(y_te, preds)), 4),
                "precision": round(float(precision_score(y_te, preds, zero_division=0)), 4),
                "recall":    round(float(recall_score(y_te, preds, zero_division=0)), 4),
                "f1":        round(float(f1_score(y_te, preds, zero_division=0)), 4),
                "roc_auc":   round(float(roc_auc_score(y_te, probs)), 4),
            }
            feature_importance = dict(zip(
                feature_cols,
                [round(float(x), 4) for x in model.feature_importances_]
            ))

            # Apply XGBoost to ALL rows
            X_full    = scaler.transform(X.values)
            all_preds = model.predict(X_full)
            all_probs = model.predict_proba(X_full)[:, 1]
            for i, r in enumerate(results):
                r["_status"] = "Fraudulent" if all_preds[i] == 1 else "Safe"
                r["_score"]  = round(float(all_probs[i]) * 100, 1)
                r["_source"] = "xgboost"

            logger.info(f"XGBoost done — F1:{metrics['f1']} AUC:{metrics['roc_auc']}")

        except Exception as e:
            logger.warning(f"XGBoost failed, keeping heuristics: {e}", exc_info=True)

    # ── Save to MongoDB ───────────────────────────────────────────────────────
    try:
        transactions_col.delete_many({"dataset_id": dataset_id})
        if results:
            transactions_col.insert_many(results[:10000])

        datasets_col.update_one(
            {"id": dataset_id},
            {"$set": {"status": "trained", "row_count": len(results), "metrics": metrics}}
        )
    except Exception as e:
        logger.error(f"Training persistence failed: {e}", exc_info=True)
        datasets_col.update_one({"id": dataset_id}, {"$set": {"status": "error"}})
        raise HTTPException(500, f"Training save failed: {str(e)}")

    fc = sum(1 for r in results if r["_status"] == "Fraudulent")
    sc = sum(1 for r in results if r["_status"] == "Suspicious")
    return {
        "dataset_id": dataset_id,
        "total": len(results),
        "fraudulent": fc,
        "suspicious": sc,
        "safe": len(results) - fc - sc,
        "metrics": metrics,
        "feature_importance": feature_importance,
        "xgboost_used": bool(metrics),
    }

# ── Transactions ──────────────────────────────────────────────────────────────
@router.get("/transactions")
def get_transactions(
    status: Optional[str] = None,
    page: int = 1,
    per_page: int = 500,
    dataset_id: Optional[str] = None,
    user=Depends(get_current_user)
):
    # If no dataset_id given, use the latest dataset for this user
    if not dataset_id:
        latest = datasets_col.find_one(
            {"uploaded_by": user["email"]},
            {"id": 1},
            sort=[("uploaded_at", -1)]
        )
        dataset_id = latest["id"] if latest else None

    q = {}
    if dataset_id:
        q["dataset_id"] = dataset_id
    if status and status != "All":
        q["_status"] = status
    total = transactions_col.count_documents(q)
    skip  = (page - 1) * per_page
    data  = list(transactions_col.find(q, {"_id": 0}).skip(skip).limit(per_page))
    return {"total": total, "page": page, "per_page": per_page, "data": data}

@router.get("/analytics/summary")
def analytics_summary(user=Depends(get_current_user)):
    latest = datasets_col.find_one(
        {"uploaded_by": user["email"]}, {"id": 1}, sort=[("uploaded_at", -1)]
    )
    base_q = {"dataset_id": latest["id"]} if latest else {}
    total      = transactions_col.count_documents(base_q)
    fraudulent = transactions_col.count_documents({**base_q, "_status": "Fraudulent"})
    suspicious = transactions_col.count_documents({**base_q, "_status": "Suspicious"})
    fraud_amts = [
        t.get("_amount_inr", 0) or 0
        for t in transactions_col.find({**base_q, "_status": "Fraudulent"}, {"_amount_inr": 1, "_id": 0})
    ]
    total_inr = sum(fraud_amts)
    return {
        "total": total,
        "fraudulent": fraudulent,
        "suspicious": suspicious,
        "safe": total - fraudulent - suspicious,
        "total_fraud_inr": total_inr,
        "avg_fraud_inr": total_inr / max(fraudulent, 1),
        "detection_rate": round(fraudulent / max(total, 1) * 100, 2),
    }

# ── Blocks ────────────────────────────────────────────────────────────────────
@router.get("/blocks")
def get_blocks(user=Depends(get_current_user)):
    return [b["entity"] for b in blocks_col.find({}, {"_id": 0})]

@router.post("/blocks")
def add_block(body: dict, user=Depends(get_current_user)):
    entity = body.get("entity", "").strip()
    if not entity:
        raise HTTPException(400, "Entity required")
    blocks_col.update_one({"entity": entity}, {"$set": {"entity": entity}}, upsert=True)
    return {"blocked": [b["entity"] for b in blocks_col.find({}, {"_id": 0})]}

@router.delete("/blocks/{entity}")
def remove_block(entity: str, user=Depends(get_current_user)):
    blocks_col.delete_one({"entity": entity})
    return {"blocked": [b["entity"] for b in blocks_col.find({}, {"_id": 0})]}

# ── CORS — must be before include_router ──────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_origin_regex=".*",
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)

# ── Mount ─────────────────────────────────────────────────────────────────────
app.include_router(router)

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, reload=True)