# Orbis Protect models (trained from scratch)

No ML libraries and no AI APIs: numpy for linear algebra, everything else (features, optimizer, metrics, ROC-AUC) is implemented in these scripts.

## Data (not committed — download first)
```bash
mkdir -p ml/data && cd ml/data
curl -L -o phiusiil.zip "https://archive.ics.uci.edu/static/public/967/phiusiil+phishing+url+dataset.zip" && unzip phiusiil.zip
curl -L -o smsspam.zip  "https://archive.ics.uci.edu/static/public/228/sms+spam+collection.zip" && unzip smsspam.zip
curl -L -o tranco.zip   "https://tranco-list.eu/top-1m.csv.zip" && unzip tranco.zip     # list 647LX was used
```

## Train
```bash
python3 ml/phishing_url/train.py    # ~70s → apps/web/src/lib/ml/url-model.json + model card + parity fixtures
python3 ml/message_scam/train.py    # <1s  → apps/web/src/lib/ml/message-model.json + model card + parity fixtures
pnpm --filter web test              # Python ↔ TypeScript parity (88 fixtures)
```

Model cards with metrics, sources and limitations: `phishing_url/model_card.json`, `message_scam/model_card.json`.
