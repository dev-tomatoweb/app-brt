const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const axios = require('axios');
const nodemailer = require('nodemailer');
require('dotenv').config();
const fs = require('fs');
const ExcelJS = require('exceljs');

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

// === AUTENTICAZIONE ===
const checkAuth = (ruoli) => {
  return (req, res, next) => {
    if (!req.session.ruolo) {
      return res.redirect('/login');
    }
    if (!ruoli.includes(req.session.ruolo)) {
      return res.status(403).send('Non autorizzato');
    }
    next();
  };
};

// === ROTTE FRONT ===

app.get('/', (req, res) => {
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  res.render('pages/login', { title: 'Login' });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  // Admin login
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
    req.session.ruolo = 'admin';
    return res.redirect('/admin');
  }

  // Magazzino login
  if (username === process.env.MAGAZZINO_USER && password === process.env.MAGAZZINO_PASSWORD) {
    req.session.ruolo = 'magazzino';
    return res.redirect('/magazzino');
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

// Funzione helper per leggere le richieste di reso
const leggiRichiesteReso = () => {
  const filePath = path.join(__dirname, 'data', 'resi.json');
  if (fs.existsSync(filePath)) {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(fileContent);
  }
  return [];
};

// Funzione helper per salvare le richieste di reso
const salvaRichiesteReso = (richieste) => {
  const filePath = path.join(__dirname, 'data', 'resi.json');
  // Crea la directory se non esiste
  if (!fs.existsSync(path.dirname(filePath))) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(richieste, null, 2));
};

// === DASHBOARD ADMIN ===
app.get('/admin', async (req, res) => {
  if (req.session.ruolo !== 'admin') return res.redirect('/login');

  const page = parseInt(req.query.page) || 1;
  const perPage = 10;
  const dataInizio = req.query.dataInizio;
  const dataFine = req.query.dataFine;
  const stato = req.query.stato;

  try {
    let params = {
        per_page: perPage,
      page,
      orderby: 'date',
      order: 'desc'
    };

    // Aggiungi filtri se presenti
    if (dataInizio) {
      params.after = new Date(dataInizio).toISOString();
    }
    if (dataFine) {
      params.before = new Date(dataFine).toISOString();
    }
    if (stato && stato !== 'all') {
      params.status = stato;
    }

    const { data: ordini } = await wooApi.get('/orders', { params });
    const hasMore = ordini.length === perPage;
    const richieste = leggiRichiesteReso();

    // Recupera i dettagli degli ordini per le richieste di reso
    const richiesteConDettagli = await Promise.all(richieste.map(async (richiesta) => {
      try {
        const { data: ordine } = await wooApi.get(`/orders/${richiesta.ordineId}`);
        return {
          ...richiesta,
          cliente: {
            nome: `${ordine.billing.first_name} ${ordine.billing.last_name}`,
            email: ordine.billing.email,
            telefono: ordine.billing.phone
          },
          totale: ordine.total,
          woocommerceUrl: `https://theflexx.com/wp-admin/post.php?post=${richiesta.ordineId}&action=edit`
        };
      } catch (error) {
        console.error(`Errore recupero ordine ${richiesta.ordineId}:`, error.message);
        return richiesta;
      }
    }));

    res.render('pages/admin', {
      title: 'TheFlexx - Admin',
      ruolo: 'admin',
      ordini: ordini,
      richieste: richiesteConDettagli,
      page,
      hasMore,
      filtri: {
        dataInizio: dataInizio || '',
        dataFine: dataFine || '',
        stato: stato || 'all'
      }
    });
  } catch (err) {
    console.error('Errore ordini admin:', err.message);
    res.render('pages/admin', {
      title: 'Errore',
      ruolo: 'admin',
      ordini: [],
      richieste: [],
      page: 1,
      hasMore: false,
      filtri: {
        dataInizio: '',
        dataFine: '',
        stato: 'all'
      }
    });
  }
});

app.get('/admin/reso/:orderId', async (req, res) => {
  if (req.session.ruolo !== 'admin') return res.redirect('/login');

  const ordineId = req.params.orderId;

  try {
    const { data: ordine } = await wooApi.get(`/orders/${ordineId}`);
    const richieste = leggiRichiesteReso();
    const richiesta = richieste.find(r => r.ordineId === ordineId);

    res.render('pages/admin-reso', {
      title: 'Richiesta Reso',
      ordine,
      richiesta
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
    // Recupera gli ordini dell'utente loggato
    const { data: ordini } = await wooApi.get('/orders', {
      params: {
        customer: req.session.user_id,
        orderby: 'date',
        order: 'desc'
      }
    });

    // Recupera le richieste di reso dell'utente
    const richieste = leggiRichiesteReso().filter(r => r.email === req.session.email);

    // Arricchisci gli ordini con i dettagli dei prodotti
    const ordiniConDettagli = await Promise.all(ordini.map(async (ordine) => {
      try {
        const { data: dettagliOrdine } = await wooApi.get(`/orders/${ordine.id}`);
        return {
          ...ordine,
          prodotti: dettagliOrdine.line_items.map(item => ({
            name: item.name,
            quantity: item.quantity,
            sku: item.sku
          }))
        };
      } catch (error) {
        console.error(`Errore recupero dettagli ordine ${ordine.id}:`, error.message);
        return ordine;
      }
    }));

    res.render('pages/cliente', {
      title: 'Dashboard Cliente',
      ruolo: 'cliente',
      nome: req.session.nome,
      email: req.session.email,
      ordini: ordiniConDettagli,
      richieste: richieste
    });
  } catch (err) {
    console.error('Errore ordini cliente:', err.message);
    res.render('pages/cliente', {
      title: 'Errore',
      ruolo: 'cliente',
      nome: req.session.nome,
      email: req.session.email,
      ordini: [],
      richieste: []
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

    const richieste = leggiRichiesteReso();
    const richiesta = richieste.find(r => r.ordineId === ordineId);

    res.render('pages/cliente-reso', {
      title: 'Richiesta Reso Cliente',
      ordine,
      email: req.session.email,
      richiesta
    });
  } catch (err) {
    console.error('Errore caricamento ordine cliente:', err.message);
    res.status(500).send('Errore nel caricamento ordine');
  }
});

// === API: richiesta di reso ===
app.post('/api/richiesta-reso', (req, res) => {
  const { ordineId, email, motivo, note } = req.body;
  const lineItemsRaw = req.body.lineItems || [];

  try {
    // Filtra solo i prodotti selezionati e formatta i dati
    const prodottiSelezionati = Object.values(lineItemsRaw)
      .filter(item => item.selected === 'true')
      .map(item => ({
        name: item.name,
        quantity: parseInt(item.quantity),
        sku: item.sku
      }));

    if (prodottiSelezionati.length === 0) {
      return res.status(400).send('Seleziona almeno un prodotto da restituire');
    }

    const richieste = leggiRichiesteReso();
    const timestamp = new Date().toISOString();
    
    // Crea la nuova richiesta
    const nuovaRichiesta = {
      ordineId,
      email: email || 'admin@internal',
      prodotti: prodottiSelezionati,
      data: timestamp,
      stato: 'in_attesa',
      riferimento: `${ordineId}-${Date.now()}`,
      motivo,
      note
    };

    richieste.push(nuovaRichiesta);
    salvaRichiesteReso(richieste);

    console.log('✅ Richiesta reso salvata:', {
    ordineId,
      prodotti: prodottiSelezionati,
      timestamp,
      motivo
    });

    // Reindirizza con messaggio di successo
    req.session.successMessage = 'Richiesta di reso inviata con successo!';
    res.redirect('/cliente#reso');

  } catch (error) {
    console.error('Errore salvataggio richiesta:', error);
    req.session.errorMessage = 'Errore nel salvataggio della richiesta';
    res.redirect('/cliente#reso');
  }
});

// === API: elimina richiesta reso ===
app.post('/api/elimina-reso', (req, res) => {
  const { ordineId } = req.body;

  try {
    const richieste = leggiRichiesteReso();
    const nuoveRichieste = richieste.filter(r => r.ordineId != ordineId);
    salvaRichiesteReso(nuoveRichieste);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Errore eliminazione richiesta:', error);
    res.status(500).json({ success: false, error: 'Errore nell\'eliminazione della richiesta' });
  }
});

// === API: autorizza reso e genera etichetta ===
app.post('/api/autorizza-reso', checkAuth(['admin']), async (req, res) => {
  try {
    console.log('🔄 Inizio processo autorizzazione reso:', req.body);
    const { ordineId } = req.body;

    // Recupera la richiesta di reso
    const richieste = leggiRichiesteReso();
    const richiesta = richieste.find(r => r.ordineId == ordineId);
    if (!richiesta) {
      console.error('❌ Richiesta non trovata per ordine:', ordineId);
      return res.status(404).json({ error: 'Richiesta non trovata' });
    }

    // Se l'etichetta è già stata generata, usa quella esistente
    if (richiesta.stato === 'etichetta_generata' && richiesta.labelBuffer) {
      console.log('♻️ Ristampa etichetta esistente per ordine:', ordineId);
      return res.send(Buffer.from(richiesta.labelBuffer, 'base64'));
    }

    console.log('🔍 Recupero dettagli ordine da WooCommerce...');
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
      senderReference: ordineId
    };

    console.log('📝 Generazione etichetta BRT...');
    const labelBuffer = await chiamaBRT(dati);
    console.log('✅ Etichetta BRT generata con successo');

    // Invia email solo se è la prima generazione dell'etichetta
    if (richiesta.stato !== 'etichetta_generata') {
      try {
        console.log('📧 Invio email di conferma...');
        await inviaEmailReso(richiesta.email, richiesta.prodotti, labelBuffer);
        console.log('✅ Email inviata con successo');
      } catch (emailError) {
        console.error('⚠️ Errore invio email ma continuo il processo:', emailError);
      }

      // Aggiorna lo stato della richiesta
      richiesta.stato = 'etichetta_generata';
      richiesta.labelBuffer = labelBuffer.toString('base64');
      richiesta.dataGenerazione = new Date().toISOString();
      salvaRichiesteReso(richieste);
      console.log('✅ Stato richiesta aggiornato');
    }

    // Invia l'etichetta al browser
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=etichetta-reso.pdf');
    return res.send(labelBuffer);

  } catch (error) {
    console.error('❌ Errore autorizzazione reso:', {
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({ error: 'Errore durante l\'autorizzazione del reso' });
  }
});

// === API: esporta ordini in Excel ===
app.get('/api/esporta-ordini', checkAuth(['admin', 'magazzino']), async (req, res) => {
  const { dataInizio, dataFine, stato } = req.query;

  try {
    let params = {
      per_page: 100, // Aumentiamo il numero per l'export
      orderby: 'date',
      order: 'desc'
    };

    if (dataInizio) params.after = new Date(dataInizio).toISOString();
    if (dataFine) params.before = new Date(dataFine).toISOString();
    if (stato && stato !== 'all') params.status = stato;

    const { data: ordini } = await wooApi.get('/orders', { params });

    // Crea un nuovo workbook Excel
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Ordini');

    // Intestazioni
    worksheet.columns = [
      { header: 'ID Ordine', key: 'id', width: 10 },
      { header: 'Data', key: 'data', width: 20 },
      { header: 'Cliente', key: 'cliente', width: 30 },
      { header: 'Indirizzo', key: 'indirizzo', width: 40 },
      { header: 'Prodotto', key: 'prodotto', width: 40 },
      { header: 'SKU', key: 'sku', width: 15 },
      { header: 'EAN', key: 'ean', width: 15 },
      { header: 'Quantità', key: 'quantita', width: 10 },
      { header: 'Stato', key: 'stato', width: 15 },
      { header: 'Totale', key: 'totale', width: 15 }
    ];

    // Stile intestazioni
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };

    // Popola il foglio
    ordini.forEach(ordine => {
      ordine.line_items.forEach(item => {
        worksheet.addRow({
          id: ordine.id,
          data: new Date(ordine.date_created).toLocaleString(),
          cliente: `${ordine.billing.first_name} ${ordine.billing.last_name}`,
          indirizzo: `${ordine.shipping.address_1}, ${ordine.shipping.postcode} ${ordine.shipping.city} (${ordine.shipping.state})`,
          prodotto: item.name,
          sku: item.sku || '',
          ean: item.ean || '',
          quantita: item.quantity,
          stato: ordine.status,
          totale: ordine.total
        });
      });
    });

    // Imposta il tipo di contenuto e invia il file
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=ordini-${new Date().toISOString().split('T')[0]}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Errore esportazione Excel:', error);
    res.status(500).send('Errore durante l\'esportazione');
  }
});

// === DASHBOARD MAGAZZINO ===
app.get('/magazzino', checkAuth(['magazzino', 'admin']), async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = 10;
  const dataInizio = req.query.dataInizio;
  const dataFine = req.query.dataFine;
  const stato = req.query.stato;

  try {
    let params = {
      per_page: perPage,
      page,
      orderby: 'date',
      order: 'desc'
    };

    if (dataInizio) params.after = new Date(dataInizio).toISOString();
    if (dataFine) params.before = new Date(dataFine).toISOString();
    if (stato && stato !== 'all') params.status = stato;

    const { data: ordini } = await wooApi.get('/orders', { params });
    const hasMore = ordini.length === perPage;

    res.render('pages/magazzino', {
      title: 'TheFlexx - Magazzino',
      ruolo: req.session.ruolo,
      ordini: ordini,
      page,
      hasMore,
      filtri: {
        dataInizio: dataInizio || '',
        dataFine: dataFine || '',
        stato: stato || 'all'
      }
    });
  } catch (err) {
    console.error('Errore ordini magazzino:', err.message);
    res.render('pages/magazzino', {
      title: 'Errore',
      ruolo: req.session.ruolo,
      ordini: [],
      page: 1,
      hasMore: false,
      filtri: {
        dataInizio: '',
        dataFine: '',
        stato: 'all'
      }
    });
  }
});

// === Funzione: invia email reso ===
async function inviaEmailReso(destinatario, prodotti, labelBuffer) {
  try {
    console.log('📧 Preparazione email con i seguenti parametri:', {
      destinatarioOriginale: destinatario,
      numProdotti: prodotti.length,
      hasLabel: !!labelBuffer
    });

    // Configurazione SMTP
    const transporter = nodemailer.createTransport({
      host: 'posta.theflexx.com',
      port: 587,
      secure: false,
      requireTLS: true,
      connectionTimeout: 10000, // 10 secondi
      greetingTimeout: 5000,   // 5 secondi
      debug: true,             // abilita debug
      logger: true,            // abilita logging
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      },
      tls: {
        rejectUnauthorized: false,
        minVersion: 'TLSv1'
      }
    });

    // Log della configurazione
    console.log('📧 Configurazione SMTP:', {
      host: 'posta.theflexx.com',
      port: 587,
      user: process.env.SMTP_USER
    });

    // Verifica la configurazione SMTP
    await transporter.verify();
    console.log('✅ Configurazione SMTP verificata con successo');

    // Prepara il corpo dell'email
    const mailOptions = {
      from: {
        name: 'TheFlexx',
        address: 'noreply@theflexx.com'
      },
      to: 'marco@tomatoweb.net',
      subject: "Reso approvato - The Flexx",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <img src="https://theflexx.com/wp-content/uploads/2025/02/the_flexx_logo_new_bw-1.png" alt="The Flexx Logo" style="max-width: 180px; margin: 20px 0;">
          
          <h2>Il tuo reso è stato approvato</h2>
          
          <p>Il reso per i seguenti prodotti è stato approvato:</p>
          
          <ul>
            ${prodotti.map(p => `<li>${p.name} (Quantità: ${p.quantity})</li>`).join('')}
          </ul>

          <p>In allegato trovi l'etichetta per il reso. Porta il pacco al fermopoint più vicino.<br>
          Puoi trovare il punto più vicino a questo indirizzo:<br>
          <a href="https://www.mybrt.it/it/mybrt/parcel-shops">https://www.mybrt.it/it/mybrt/parcel-shops</a></p>

          <p>Puoi anche accedere alla tua area clienti per scaricare l'etichetta in qualsiasi momento.</p>

          <p>Grazie per aver scelto il nostro servizio.</p>
          
          <hr>
          <p style="font-size: 12px; color: #666;">
            Questo è un messaggio automatico, non rispondere a questa email.<br>
            <strong>Email cliente originale: ${destinatario}</strong>
          </p>
        </div>
      `,
      attachments: [{
        filename: 'etichetta-reso.pdf',
        content: labelBuffer
      }]
    };

    console.log('📤 Invio email tramite SMTP...');
    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Email inviata con successo:', info.messageId);
    return info;

  } catch (error) {
    console.error('❌ Errore invio email:', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

// === Route di test per l'invio email ===
app.get('/test-email', async (req, res) => {
  try {
    console.log('🔄 Test invio email...');
    
    // Dati di test
    const testData = {
      destinatario: 'marco@tomatoweb.net',
      prodotti: [{
        name: 'Prodotto Test',
        quantity: 1
      }],
      labelBuffer: Buffer.from('Test PDF Content')
    };

    // Prova a inviare l'email
    await inviaEmailReso(testData.destinatario, testData.prodotti, testData.labelBuffer);
    
    res.send('Email inviata con successo!');
  } catch (error) {
    console.error('❌ Errore test email:', error);
    res.status(500).send('Errore nell\'invio dell\'email: ' + error.message);
  }
});

// === Funzione: chiamata a BRT ===
async function chiamaBRT(dati) {
  // Genera codice univoco usando ordineId e timestamp
  const timestamp = Date.now().toString().slice(-8); // ultimi 8 numeri del timestamp
  const riferimento = `${dati.senderReference}-${timestamp}`; // formato: ordineId-timestamp

  console.log('📦 Generazione riferimento:', {
    ordineId: dati.senderReference,
    timestamp,
    riferimento
  });

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
      numericSenderReference: parseInt(dati.senderReference),
      alphanumericSenderReference: riferimento,
      isCODMandatory: 0,
      cashOnDelivery: 0,
      codCurrency: "EUR",
      notes: `Reso ordine #${dati.senderReference}`
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

// Avvia il server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server in ascolto sulla porta ${PORT}`);
});
