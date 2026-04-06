# FraudWatch — UPI Fraud Detection System

[![Live Demo](https://img.shields.io/badge/Live-Demo-667eea?style=for-the-badge)](https://fraudwatch.vercel.app)
[![Backend](https://img.shields.io/badge/Backend-Render-46e3b7?style=for-the-badge)](https://fraudwatch-backend.onrender.com)
[![Python](https://img.shields.io/badge/Python-3.11-blue?style=for-the-badge)](https://python.org)
[![React](https://img.shields.io/badge/React-18-61dafb?style=for-the-badge)](https://reactjs.org)
[![License](https://img.shields.io/badge/License-Proprietary-red?style=for-the-badge)]()
A full-stack fraud detection dashboard that processes transaction datasets, trains a real XGBoost model with SMOTE for class imbalance, and displays live fraud analytics in Indian Rupees (₹).

Built as part of the project portfolio by **Hithashree K** — 4th Year CSE (Cybersecurity), ACS College of Engineering (VTU), Bengaluru.

---

## What It Does

Upload any transaction CSV → instantly get heuristic fraud scores → XGBoost trains on the backend → results update with real ML predictions → all data saved to MongoDB.

---

## Features

- **Dual Detection** — Instant browser-side heuristics + real XGBoost model trained on your data
- **SMOTE** — Handles class imbalance (real fraud datasets are 99%+ non-fraud)
- **Live Model Metrics** — Accuracy, Precision, Recall, F1 Score, ROC-AUC shown on dashboard
- **INR Currency** — All amounts displayed in Indian Rupees (₹)
- **Full Analytics** — Status distribution, amount distribution, detection source charts
- **Block Management** — Block fraudulent entities, saved permanently to MongoDB
- **Any CSV** — Works with any transaction CSV, auto-detects fraud column
- **JWT Auth** — Secure login/register with bcrypt password hashing
- **Production Deployed** — Vercel + Render + MongoDB Atlas

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React.js, Recharts |
| Backend | FastAPI, Python 3.11, Uvicorn |
| ML | XGBoost, scikit-learn, imbalanced-learn (SMOTE) |
| Database | MongoDB Atlas |
| Auth | JWT (python-jose) + bcrypt (passlib) |
| Frontend Deploy | Vercel |
| Backend Deploy | Render |

---

## How Fraud Detection Works

### Phase 1 — Heuristic Scoring (instant, runs in browser)

When you upload a CSV, scoring runs immediately without waiting for the backend:

| Rule | Score Added |
|------|-------------|
| Amount > 3 std deviations above mean | +35 |
| Amount > 2 std deviations | +20 |
| Transaction type TRANSFER / CASH_OUT | +15 |
| Account drained to zero | +25 |
| Destination balance unchanged | +20 |
| Transaction between 12AM–5AM | +25 |
| Amount > ₹1 Lakh | +15 |
| Known label: is_fraud = 1 | forced to 85 |

**Score thresholds:**
- 0–29 → ✅ Safe
- 30–59 → ⚠️ Suspicious
- 60–99 → 🚨 Fraudulent

### Phase 2 — XGBoost Training (backend, runs simultaneously)

While heuristics display instantly, the backend:

```
CSV Upload
    ↓
Strip column names (fix trailing spaces)
    ↓
Label encode categorical columns
    ↓
Fill missing values with column mean
    ↓
Train/test split (80/20, stratified)
    ↓
SMOTE — oversample minority fraud class
    ↓
StandardScaler — normalise features
    ↓
XGBoost.fit() — 100 estimators
    ↓
Predict on ALL rows
    ↓
Save to MongoDB
    ↓
Frontend updates with XGBoost results
```

Heuristic badges are replaced with XGBoost badges once training completes.

---

## Project Structure

```
fraudwatch-v2/
├── backend/
│   ├── server.py           ← FastAPI: auth, upload, train, transactions, blocks
│   ├── requirements.txt    ← Python dependencies
│   ├── runtime.txt         ← Python 3.11.9 (for Render)
│   └── .env                ← Environment variables (not committed)
│
└── frontend/
    ├── src/
    │   └── App.js          ← Full React app: all 4 pages, heuristics, API integration
    ├── package.json
    └── .env                ← REACT_APP_BACKEND_URL
```

---

## Pages

| Page | Description |
|------|-------------|
| **Dashboard** | Upload CSV, view model metrics, recent fraud alerts, summary stats |
| **Transactions** | Paginated table with filter (All/Fraudulent/Suspicious/Safe) and search |
| **Analytics** | Pie charts, amount distribution, detection source breakdown |
| **Block Management** | Block/unblock entities, saved to MongoDB |

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register user |
| POST | `/api/auth/login` | Login, returns JWT |
| GET | `/api/auth/me` | Current user info |
| POST | `/api/datasets/upload` | Upload CSV |
| GET | `/api/datasets` | List datasets |
| POST | `/api/datasets/{id}/train` | Train XGBoost model |
| GET | `/api/transactions` | Paginated transaction results |
| GET | `/api/analytics/summary` | Summary statistics |
| GET | `/api/blocks` | Get blocked entities |
| POST | `/api/blocks` | Block entity |
| DELETE | `/api/blocks/{entity}` | Unblock entity |

---

## Local Setup

### Requirements
- Node.js 18+
- Python 3.11
- MongoDB (local or Atlas)

### Backend

```bash
cd fraudwatch-v2/backend

# Install Python dependencies
pip install -r requirements.txt

# Create .env
MONGO_URI=mongodb://localhost:27017
DB_NAME=fraudwatch
JWT_SECRET=your-secret-key-change-this
FRONTEND_URL=*
PORT=8000

# Start
uvicorn server:app --reload --port 8000
# Swagger UI: http://localhost:8000/docs
```

### Frontend

```bash
cd fraudwatch-v2/frontend

npm install

# Create .env
PORT=3001
REACT_APP_BACKEND_URL=http://localhost:8000

npm start
# App: http://localhost:3001
```

---

## Environment Variables

### backend/.env
```env
MONGO_URI=mongodb+srv://user:password@cluster.mongodb.net/
DB_NAME=fraudwatch
JWT_SECRET=replace-with-a-long-random-string
FRONTEND_URL=*
PORT=8000
```

### frontend/.env
```env
PORT=3001
REACT_APP_BACKEND_URL=https://your-backend.onrender.com
```

---

## Deployment Guide

### 1. MongoDB Atlas (free)
1. Sign up at [mongodb.com/atlas](https://mongodb.com/atlas)
2. Create free M0 cluster
3. Network Access → Add IP → `0.0.0.0/0` (allow all)
4. Copy connection string

### 2. Backend → Render
1. Push repo to GitHub
2. New Web Service at [render.com](https://render.com)
3. Settings:
   - Root Directory: `backend`
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `gunicorn server:app -w 2 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:$PORT`
4. Environment variables: `MONGO_URI`, `JWT_SECRET`, `DB_NAME`, `FRONTEND_URL=*`

### 3. Frontend → Vercel
```bash
cd frontend
npm install -g vercel
vercel
```
Add `REACT_APP_BACKEND_URL=https://your-backend.onrender.com` in Vercel dashboard → redeploy.

---

## Recommended Dataset

**PaySim — Synthetic Financial Datasets For Fraud Detection**
- [Download from Kaggle](https://www.kaggle.com/datasets/ealaxi/paysim1)
- 6.3M rows, 0.13% fraud — realistic class imbalance
- Columns: `step`, `type`, `amount`, `nameOrig`, `oldbalanceOrg`, `newbalanceOrig`, `nameDest`, `oldbalanceDest`, `newbalanceDest`, `isFraud`

Use a 50k–100k row sample for fast local testing.

---

## Results on Sample Dataset (1,000 rows)

| Metric | Score |
|--------|-------|
| Accuracy | 100% |
| Precision | 100% |
| Recall | 100% |
| F1 Score | 100% |
| ROC-AUC | 100% |

*Note: 100% scores on small/synthetic datasets are expected — real-world performance varies.*

---

## About the Author

**Hithashree K**
4th Year B.E. — Computer Science (Cybersecurity)
ACS College of Engineering (VTU), Bengaluru | CGPA: 8.3/10

- 📧 hithashree.govi@gmail.com
- 🌐 [Portfolio](https://hitha-portfolio-sigma.vercel.app)
- 💼 [LinkedIn](https://linkedin.com/in/hithashree)
- 🐙 [GitHub](https://github.com/hithagovi)

**Current Experience:**
- AI/ML Engineering Intern — Rangsons Aerospace
- LLM & Web Developer — Solvimate
- Cybersecurity Intern — Elevate Labs

---

## License

© 2026 Hithashree K. All rights reserved.

This project is for portfolio and demonstration purposes only.
Unauthorized copying, modification, distribution, or commercial use is strictly prohibited.
