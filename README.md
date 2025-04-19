# Sistema Gestione Resi TheFlexx

Sistema web per la gestione dei resi con integrazione BRT (Bartolini) per TheFlexx.

## Funzionalità

- **Gestione Resi**
  - Richiesta reso da parte del cliente
  - Approvazione reso da admin
  - Generazione etichetta BRT
  - Invio email automatico con etichetta

- **Dashboard Admin**
  - Visualizzazione richieste di reso
  - Gestione stato richieste
  - Generazione e download etichette
  - Esportazione ordini in Excel

- **Area Cliente**
  - Visualizzazione ordini
  - Richiesta reso
  - Download etichetta

- **Area Magazzino**
  - Visualizzazione ordini
  - Esportazione in Excel

## Installazione

1. Clona il repository
```bash
git clone https://github.com/dev-tomatoweb/app-brt.git
cd app-brt
```

2. Installa le dipendenze
```bash
npm install
```

3. Crea il file `.env` con le seguenti variabili:
```env
# Server
PORT=3000

# WooCommerce
WC_CONSUMER_KEY=your_key
WC_CONSUMER_SECRET=your_secret

# BRT
BRT_API_URL=https://api.url
BRT_USERID=your_userid
BRT_PASSWORD=your_password
BRT_DEPOT=your_depot
SENDER_CUSTOMER_CODE=your_code

# SMTP
SMTP_HOST=posta.theflexx.com
SMTP_PORT=587
SMTP_USER=your_email
SMTP_PASS=your_password

# Auth
ADMIN_USER=admin_username
ADMIN_PASSWORD=admin_password
MAGAZZINO_USER=magazzino_username
MAGAZZINO_PASSWORD=magazzino_password
```

4. Avvia il server
```bash
node server/index.js
```

## Utilizzo

- **Admin**: `/admin`
  - Login con credenziali admin
  - Gestione richieste reso
  - Generazione etichette

- **Cliente**: `/cliente`
  - Login con credenziali WordPress
  - Visualizzazione ordini
  - Richiesta reso

- **Magazzino**: `/magazzino`
  - Login con credenziali magazzino
  - Visualizzazione ordini
  - Export Excel

## Note Tecniche

- Node.js + Express
- Template engine: EJS
- Integrazione con WooCommerce REST API
- Integrazione con BRT API per etichette
- Invio email via SMTP
- Export Excel con ExcelJS

## Sviluppo

Per contribuire al progetto:
1. Crea un fork
2. Crea un branch per la feature (`git checkout -b feature/nome-feature`)
3. Commit delle modifiche (`git commit -am 'Aggiunta feature'`)
4. Push del branch (`git push origin feature/nome-feature`)
5. Crea una Pull Request 