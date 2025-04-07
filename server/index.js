const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const axios = require('axios');
require('dotenv').config();
const fs = require('fs');

const app = express();

// === CONFIG ===
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sessioni
app.use(session({
  secret: 'una-frase-segreta-sicura',
  resave: false,
  saveUninitialized: false
}));

// EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// === WooCommerce API ===
const wooApi = axios.create({
  baseURL: 'https://theflexx.com/wp-json/wc/v3',
  auth: {
    username: process.env.WC_CONSUMER_KEY,
    password: process.env.WC_CONSUMER_SECRET
  }
});

// === Database temporaneo (in memoria) per richieste di reso ===
const richiesteReso = [];

// === ROTTE FRONT ===

app.get('/', (req, res) => {
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  res.render('pages/login', { title: 'Login' });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (username === 'admin' && password === 'admin') {
    req.session.ruolo = 'admin';
    return res.redirect('/admin');
  }

  try {
    const response = await axios.post('https://theflexx.com/wp-json/jwt-auth/v1/token', {
      username,
      password
    });

    const { token, user_email, user_display_name } = response.data;

    const userInfo = await axios.get('https://theflexx.com/wp-json/wp/v2/users/me', {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const userId = userInfo.data.id;

    req.session.ruolo = 'cliente';
    req.session.jwt = token;
    req.session.email = user_email;
    req.session.nome = user_display_name;
    req.session.user_id = userId;

    res.redirect('/cliente');
  } catch (err) {
    console.error('Errore login JWT:', err.response?.data || err.message);
    res.render('pages/login', {
      title: 'Login',
      error: 'Credenziali non valide o server non raggiungibile'
    });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// === DASHBOARD ADMIN ===
app.get('/admin', async (req, res) => {
  if (req.session.ruolo !== 'admin') return res.redirect('/login');

  const page = parseInt(req.query.page) || 1;
  const perPage = 10;

  try {
    const { data } = await wooApi.get('/orders', {
      params: {
        per_page: perPage,
        page
      }
    });

    const hasMore = data.length === perPage;

    res.render('pages/admin', {
      title: 'TheFlexx - Admin',
      ruolo: 'admin',
      ordini: data,
      richieste: richiesteReso,
      page,
      hasMore
    });
  } catch (err) {
    console.error('Errore ordini admin:', err.message);
    res.render('pages/admin', {
      title: 'Errore',
      ruolo: 'admin',
      ordini: [],
      richieste: [],
      page: 1,
      hasMore: false
    });
  }
});

app.get('/admin/reso/:orderId', async (req, res) => {
  if (req.session.ruolo !== 'admin') return res.redirect('/login');

  const ordineId = req.params.orderId;

  try {
    const { data: ordine } = await wooApi.get(`/orders/${ordineId}`);

    res.render('pages/admin-reso', {
      title: 'Richiesta Reso',
      ordine
    });
  } catch (err) {
    console.error('Errore caricamento ordine:', err.message);
    res.status(500).send('Errore nel caricamento ordine');
  }
});

// === DASHBOARD CLIENTE ===
app.get('/cliente', async (req, res) => {
  if (req.session.ruolo !== 'cliente') return res.redirect('/login');

  try {
    const { data } = await wooApi.get('/orders', {
      params: {
        customer: req.session.user_id
      }
    });

    res.render('pages/cliente', {
      title: 'Dashboard Cliente',
      ruolo: 'cliente',
      nome: req.session.nome,
      email: req.session.email,
      ordini: data
    });
  } catch (err) {
    console.error('Errore ordini cliente:', err.message);
    res.render('pages/cliente', {
      title: 'Errore',
      ruolo: 'cliente',
      nome: req.session.nome,
      email: req.session.email,
      ordini: []
    });
  }
});

app.get('/cliente/reso/:orderId', async (req, res) => {
  if (req.session.ruolo !== 'cliente') return res.redirect('/login');

  const ordineId = req.params.orderId;

  try {
    const { data: ordine } = await wooApi.get(`/orders/${ordineId}`);

    // Assicura che l'ordine sia del cliente loggato
    if (ordine.customer_id != req.session.user_id) {
      return res.status(403).send('Non autorizzato');
    }

    res.render('pages/cliente-reso', {
      title: 'Richiesta Reso Cliente',
      ordine,
      email: req.session.email
    });
  } catch (err) {
    console.error('Errore caricamento ordine cliente:', err.message);
    res.status(500).send('Errore nel caricamento ordine');
  }
});


// === API: richiesta di reso ===
app.post('/api/richiesta-reso', (req, res) => {
  const { ordineId, email } = req.body;
  const lineItems = req.body.lineItems || [];

  // lato admin: email non c’è → dummy
  const userEmail = email || 'admin@internal';

  const giàRichiesto = richiesteReso.some(r => r.ordineId == ordineId && r.email === userEmail);
  if (giàRichiesto) return res.status(400).send('Reso già richiesto');

  richiesteReso.push({
    ordineId,
    email: userEmail,
    prodotti: Array.isArray(lineItems) ? lineItems : [lineItems],
    data: new Date().toISOString()
  });

  console.log('✅ Richiesta reso admin:', ordineId, 'prodotti:', lineItems);
  res.redirect('/admin');
});

// === API: autorizza reso e genera etichetta ===
app.post('/api/autorizza-reso', async (req, res) => {
  const { ordineId } = req.body;

  try {
    const { data: ordine } = await wooApi.get(`/orders/${ordineId}`);
    const dati = {
      nome: ordine.billing.first_name,
      cognome: ordine.billing.last_name,
      indirizzo: ordine.billing.address_1,
      cap: ordine.billing.postcode,
      città: ordine.billing.city,
      provincia: ordine.billing.state,
      telefono: ordine.billing.phone,
      email: ordine.billing.email,
      senderReference: ordine.id
    };

    const labelBuffer = await chiamaBRT(dati);

    const filePath = path.join(__dirname, `etichetta-${ordineId}.pdf`);
    fs.writeFileSync(filePath, labelBuffer);

    console.log('✅ Etichetta generata per ordine:', ordineId);
    res.download(filePath);
  } catch (err) {
    console.error('❌ Errore autorizzazione reso:', err.message);
    res.status(500).send('Errore durante la generazione dell’etichetta');
  }
});

// === Funzione: chiamata a BRT ===
async function chiamaBRT(dati) {
  // Genera codice univoco a 12 cifre
  const timestamp = Date.now().toString().slice(-5);
  const numericSenderRef = parseInt(`${process.env.SENDER_CUSTOMER_CODE}${dati.senderReference}`);

  const payload = {
    account: {
      userID: process.env.BRT_USERID,
      password: process.env.BRT_PASSWORD
    },
    createData: {
      departureDepot: process.env.BRT_DEPOT,
      senderCustomerCode: process.env.SENDER_CUSTOMER_CODE,
      deliveryFreightTypeCode: "DAP",
      consigneeCompanyName: `${dati.nome} ${dati.cognome}`,
      consigneeAddress: dati.indirizzo,
      consigneeZIPCode: dati.cap,
      consigneeCity: dati.città,
      consigneeCountryAbbreviationISOAlpha2: "IT",
      numberOfParcels: 1,
      weightKG: 1,
      numericSenderReference: numericSenderRef,
      isCODMandatory: 0,
      cashOnDelivery: 0,
      codCurrency: "EUR"
    },
    isLabelRequired: 1,
    labelParameters: {
      outputType: "PDF",
      isBorderRequired: 0,
      isLogoRequired: 0
    }
  };

  console.log('📤 Invio richiesta a BRT con:');
  console.log('Endpoint:', process.env.BRT_API_URL);
  console.log('Payload:', JSON.stringify(payload, null, 2));

  try {
    const response = await axios.post(process.env.BRT_API_URL, payload, {
      headers: { 'Content-Type': 'application/json' }
    });

    console.log('📦 Risposta BRT:', JSON.stringify(response.data, null, 2));

    const stream = response.data?.createResponse?.labels?.label?.[0]?.stream;

    if (!stream) {
      throw new Error('Etichetta non trovata nella risposta BRT');
    }

    return Buffer.from(stream, 'base64');

  } catch (error) {
    console.error('❌ Errore chiamata BRT:', error.response?.data || error.message);
    throw new Error('Errore nella chiamata a BRT');
  }
}

// === START ===
app.listen(3000, () => {
  console.log('✅ Server avviato su http://localhost:3000');
});
