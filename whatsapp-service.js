require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

// Files are received in-memory (as a Buffer) rather than saved to disk.
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 4001;

let sock = null;
let latestQr = null;
let isReady = false;

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = await qrcode.toDataURL(qr);
      isReady = false;
      console.log('New QR generated — waiting for scan via UI');
    }

    if (connection === 'open') {
      isReady = true;
      latestQr = null;
      console.log('✅ WhatsApp connected');
    }

    if (connection === 'close') {
      isReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Status code:', statusCode, 'Reconnecting:', shouldReconnect);
      if (shouldReconnect) startSock();
    }
  });
}

startSock();

function toJid(phoneNumber) {
  let number = String(phoneNumber).replace(/\D/g, '');
  if (number.length === 10) number = '91' + number; // default India code if missing
  return `${number}@s.whatsapp.net`;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ready: isReady });
});

app.get('/qr-status', (req, res) => {
  res.json({ ready: isReady, qr: isReady ? null : latestQr });
});

app.post('/logout', async (req, res) => {
  try {
    await sock.logout();
    isReady = false;
    res.json({ success: true, message: 'WhatsApp disconnected. Scan a new QR code to reconnect.' });
    // Restart the socket so a fresh QR is generated for the next connection —
    // without this, logout() leaves the service with no way to reconnect.
    startSock();
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Send a text-only message — just phoneNumber + message, no API key required ──
app.post('/send-text', async (req, res) => {
  const { phoneNumber, message } = req.body;

  if (!isReady) {
    return res.status(503).json({ success: false, message: 'WhatsApp not connected yet' });
  }
  if (!phoneNumber || !message) {
    return res.status(400).json({ success: false, message: 'phoneNumber and message are required' });
  }

  const jid = toJid(phoneNumber);

  try {
    const [check] = await sock.onWhatsApp(jid);
    if (!check?.exists) {
      return res.status(400).json({ success: false, message: 'This number is not registered on WhatsApp' });
    }
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, message: 'Text sent successfully' });
  } catch (err) {
    console.error('Send failed:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Send the invoice PDF as an actual file attachment (uploaded directly, no URL) ──
app.post('/send-invoice', upload.single('invoicePdf'), async (req, res) => {
  const { phoneNumber, invoiceNumber, customerName } = req.body;
  const file = req.file;

  if (!isReady) {
    return res.status(503).json({ success: false, message: 'WhatsApp not connected yet' });
  }
  if (!phoneNumber || !file) {
    return res.status(400).json({ success: false, message: 'phoneNumber and invoicePdf file are required' });
  }

  const jid = toJid(phoneNumber);
  const fileName = `Invoice_${invoiceNumber || 'bill'}.pdf`;
  const caption = `Hi ${customerName || 'there'}, here's your invoice #${invoiceNumber || ''}. Thank you for your purchase!`;

  try {
    const [check] = await sock.onWhatsApp(jid);
    if (!check?.exists) {
      return res.status(400).json({ success: false, message: 'This number is not registered on WhatsApp' });
    }

    await sock.sendMessage(jid, {
      document: file.buffer, // the actual uploaded PDF bytes, no URL fetch involved
      mimetype: 'application/pdf',
      fileName,
      caption
    });

    res.json({ success: true, message: 'Invoice file sent successfully' });
  } catch (err) {
    console.error('Send failed:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp invoice service (Baileys) running on port ${PORT}`);
});