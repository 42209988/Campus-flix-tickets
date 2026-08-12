// CampusFlix — single-file backend.
// Everything (data storage, auth, shows, tickets, M-Pesa, QR codes) lives
// here on purpose, to keep the project to a handful of files that are easy
// to upload from a phone. If this ever grows a lot, it can be split back
// into routes/services files later without changing how anything behaves.

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { nanoid } = require('nanoid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Storage — simple JSON files. No database server to set up.
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

[DATA_DIR, UPLOADS_DIR].forEach(dir => fs.existsSync(dir) || fs.mkdirSync(dir, { recursive: true }));
if (!fs.existsSync(SHOWS_FILE)) fs.writeFileSync(SHOWS_FILE, '[]');
if (!fs.existsSync(TICKETS_FILE)) fs.writeFileSync(TICKETS_FILE, '[]');

const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf-8'));
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

const Shows = {
  all: () => readJSON(SHOWS_FILE),
  published: () => Shows.all().filter(s => s.status === 'live'),
  find: id => Shows.all().find(s => s.id === id),
  create: show => { const s = Shows.all(); s.unshift(show); writeJSON(SHOWS_FILE, s); return show; },
  update: (id, updates) => {
    const s = Shows.all(); const i = s.findIndex(x => x.id === id);
    if (i === -1) return null;
    s[i] = { ...s[i], ...updates }; writeJSON(SHOWS_FILE, s); return s[i];
  },
  delete: id => writeJSON(SHOWS_FILE, Shows.all().filter(s => s.id !== id)),
  incrementSold: (id, qty) => { const s = Shows.find(id); if (!s) return; return Shows.update(id, { sold: (s.sold || 0) + qty }); }
};

const Tickets = {
  all: () => readJSON(TICKETS_FILE),
  find: id => Tickets.all().find(t => t.id === id),
  findByCheckoutRef: ref => Tickets.all().find(t => t.checkoutRequestId === ref),
  create: t => { const all = Tickets.all(); all.unshift(t); writeJSON(TICKETS_FILE, all); return t; },
  update: (id, updates) => {
    const all = Tickets.all(); const i = all.findIndex(t => t.id === id);
    if (i === -1) return null;
    all[i] = { ...all[i], ...updates }; writeJSON(TICKETS_FILE, all); return all[i];
  }
};

// ---------------------------------------------------------------------------
// M-Pesa (Safaricom Daraja) — STK push
// ---------------------------------------------------------------------------
const MPESA_BASE_URL = process.env.MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

function mpesaTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function getMpesaAccessToken() {
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await fetch(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!res.ok) throw new Error(`Failed to get M-Pesa access token: ${res.status}`);
  return (await res.json()).access_token;
}

async function initiateSTKPush({ phone, amount, accountReference, description }) {
  const token = await getMpesaAccessToken();
  const ts = mpesaTimestamp();
  const shortcode = process.env.MPESA_SHORTCODE;
  const password = Buffer.from(`${shortcode}${process.env.MPESA_PASSKEY}${ts}`).toString('base64');

  let phoneNum = phone.replace(/\s+/g, '').replace(/^\+/, '');
  if (phoneNum.startsWith('0')) phoneNum = '254' + phoneNum.slice(1);
  if (phoneNum.startsWith('7') || phoneNum.startsWith('1')) phoneNum = '254' + phoneNum;

  const res = await fetch(`${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: phoneNum,
      PartyB: shortcode,
      PhoneNumber: phoneNum,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: accountReference.slice(0, 12),
      TransactionDesc: description.slice(0, 13)
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errorMessage || 'STK push failed');
  return data;
}

// Builds a simple, clean PDF ticket receipt in memory and returns it as a Buffer.
function generateReceiptPDF({ ticket, show }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, doc.page.width, 90).fill('#0b0908');
    doc.fillColor('#c31f2a').font('Helvetica-Bold').fontSize(22).text('CAMPUS', 40, 32, { continued: true });
    doc.fillColor('#ffffff').text('FLIX');
    doc.fillColor('#e6ab35').font('Helvetica').fontSize(10).text('E-TICKET RECEIPT', 40, 62);

    doc.moveDown(3);
    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(20).text(show.title, 40, 120);
    doc.font('Helvetica').fontSize(11).fillColor('#444444');
    doc.moveDown(0.5);
    doc.text(`Category: ${show.type}`);
    doc.text(`Venue: ${show.venue}`);
    doc.text(`Date: ${show.date}   Time: ${show.time}`);

    doc.moveDown(1);
    doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).dash(3, { space: 3 }).strokeColor('#999999').stroke();
    doc.undash();
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Ticket Holder');
    doc.font('Helvetica').fontSize(11).fillColor('#444444').text(ticket.name);
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Quantity');
    doc.font('Helvetica').fontSize(11).fillColor('#444444').text(`${ticket.quantity} ticket${ticket.quantity > 1 ? 's' : ''}`);
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Amount Paid');
    doc.font('Helvetica').fontSize(11).fillColor('#444444').text(`KES ${ticket.amount}`);
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Receipt No.');
    doc.font('Helvetica').fontSize(11).fillColor('#444444').text(ticket.id.toUpperCase());

    doc.moveDown(1.5);
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#888888')
      .text('Present this receipt (printed or on your phone) at the door. Non-refundable once used.', { width: doc.page.width - 80 });

    doc.end();
  });
}

// Emails the PDF receipt to the buyer using Gmail SMTP.
async function sendTicketEmail({ to, name, show, pdfBuffer }) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD }
  });

  console.log(`[email] Sending ticket for "${show.title}" to: "${to}" from: "${process.env.EMAIL_USER}"`);

  const info = await transporter.sendMail({
    from: `"CampusFlix" <${process.env.EMAIL_USER}>`,
    to,
    subject: `Your CampusFlix Ticket — ${show.title}`,
    text: `Hi ${name},\n\nYour ticket for ${show.title} is attached as a PDF. See you there!\n\n— CampusFlix`,
    attachments: [{ filename: `campusflix-ticket-${show.title.replace(/\s+/g, '-').toLowerCase()}.pdf`, content: pdfBuffer }]
  });

  console.log(`[email] Sent. messageId=${info.messageId} accepted=${JSON.stringify(info.accepted)} rejected=${JSON.stringify(info.rejected)} response=${info.response}`);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  // Login disabled — anyone with the /admin.html link can manage shows.
  // To bring login back later, restore the session check below:
  // if (req.session && req.session.isAdmin) return next();
  // return res.status(401).json({ error: 'Not logged in' });
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, `${nanoid(10)}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Only image files allowed'))
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username !== process.env.ADMIN_USERNAME) return res.status(401).json({ error: 'Invalid username or password' });
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!hash) return res.status(500).json({ error: 'Admin password not configured. See README.' });
  if (!(await bcrypt.compare(password, hash))) return res.status(401).json({ error: 'Invalid username or password' });
  req.session.isAdmin = true;
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/admin/session', (req, res) => res.json({ isAdmin: !!(req.session && req.session.isAdmin) }));

// ---------------------------------------------------------------------------
// Show routes
// ---------------------------------------------------------------------------
const publicShowFields = ({ id, title, description, type, venue, date, time, price, capacity, sold, posterUrl }) =>
  ({ id, title, description, type, venue, date, time, price, capacity, sold, posterUrl });

app.get('/api/shows', (req, res) => res.json(Shows.published().map(publicShowFields)));

app.get('/api/shows/admin/all', requireAdmin, (req, res) => res.json(Shows.all()));

app.get('/api/shows/:id', (req, res) => {
  const show = Shows.find(req.params.id);
  if (!show || show.status !== 'live') return res.status(404).json({ error: 'Show not found' });
  res.json(publicShowFields(show));
});

app.post('/api/shows/admin', requireAdmin, upload.single('poster'), (req, res) => {
  const { title, description, type, venue, date, time, price, capacity, status } = req.body;
  if (!title || !venue || !date || !time || !price || !capacity) return res.status(400).json({ error: 'Missing required fields' });

  const show = {
    id: nanoid(10), title, description: description || '', type: type || 'Film Screening',
    venue, date, time, price: Number(price), capacity: Number(capacity), sold: 0,
    posterUrl: req.file ? `/uploads/${req.file.filename}` : null,
    status: status === 'draft' ? 'draft' : 'live', createdAt: new Date().toISOString()
  };
  Shows.create(show);
  res.status(201).json(show);
});

app.put('/api/shows/admin/:id', requireAdmin, upload.single('poster'), (req, res) => {
  const updates = { ...req.body };
  if (updates.price) updates.price = Number(updates.price);
  if (updates.capacity) updates.capacity = Number(updates.capacity);
  if (req.file) updates.posterUrl = `/uploads/${req.file.filename}`;
  const updated = Shows.update(req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Show not found' });
  res.json(updated);
});

app.delete('/api/shows/admin/:id', requireAdmin, (req, res) => { Shows.delete(req.params.id); res.json({ ok: true }); });

// ---------------------------------------------------------------------------
// Ticket / payment routes
// ---------------------------------------------------------------------------
app.post('/api/tickets/purchase', async (req, res) => {
  try {
    const { showId, name, phone, email, quantity } = req.body;
    const qty = Number(quantity) || 1;
    if (!showId || !name || !phone || !email) return res.status(400).json({ error: 'Missing name, phone, email, or show' });

    const show = Shows.find(showId);
    if (!show || show.status !== 'live') return res.status(404).json({ error: 'Show not found' });

    const remaining = show.capacity - (show.sold || 0);
    if (qty > remaining) return res.status(400).json({ error: `Only ${remaining} tickets left` });

    const amount = show.price * qty;
    const ticket = Tickets.create({
      id: nanoid(12), showId, name, phone, email, quantity: qty, amount,
      status: 'pending', checkoutRequestId: null, createdAt: new Date().toISOString()
    });

    const stk = await initiateSTKPush({ phone, amount, accountReference: 'CampusFlix', description: show.title });
    Tickets.update(ticket.id, { checkoutRequestId: stk.CheckoutRequestID });

    res.json({ ticketId: ticket.id, status: 'pending' });
  } catch (err) {
    console.error('Purchase error:', err);
    res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

app.get('/api/tickets/:id/status', (req, res) => {
  const ticket = Tickets.find(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ status: ticket.status, emailError: ticket.emailError || false });
});

app.get('/api/tickets/:id', (req, res) => {
  const ticket = Tickets.find(req.params.id);
  if (!ticket || ticket.status !== 'paid') return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket, show: Shows.find(ticket.showId) });
});

// Safaricom calls this directly after the buyer approves/declines — no auth.
app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const stkCallback = req.body?.Body?.stkCallback;
    if (!stkCallback) return res.status(400).json({ error: 'Malformed callback' });

    const { CheckoutRequestID, ResultCode } = stkCallback;
    const ticket = Tickets.findByCheckoutRef(CheckoutRequestID);
    if (!ticket) { console.warn('No ticket for', CheckoutRequestID); return res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); }

    if (ResultCode === 0) {
      Tickets.update(ticket.id, { status: 'paid' });
      Shows.incrementSold(ticket.showId, ticket.quantity);

      // Build the PDF and email it. If email fails, the ticket is still
      // valid/paid — we just flag it so the confirmation page can offer a retry.
      try {
        const show = Shows.find(ticket.showId);
        const pdfBuffer = await generateReceiptPDF({ ticket, show });
        await sendTicketEmail({ to: ticket.email, name: ticket.name, show, pdfBuffer });
      } catch (emailErr) {
        console.error('Email send error:', emailErr);
        Tickets.update(ticket.id, { emailError: true });
      }
    } else {
      Tickets.update(ticket.id, { status: 'failed' });
    }
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('Callback error:', err);
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Server error' });
  }
});

// Lets the confirmation page offer a "resend" if the first email attempt failed.
app.post('/api/tickets/:id/resend', async (req, res) => {
  try {
    const ticket = Tickets.find(req.params.id);
    if (!ticket || ticket.status !== 'paid') return res.status(404).json({ error: 'Ticket not found' });
    const show = Shows.find(ticket.showId);
    const pdfBuffer = await generateReceiptPDF({ ticket, show });
    await sendTicketEmail({ to: ticket.email, name: ticket.name, show, pdfBuffer });
    Tickets.update(ticket.id, { emailError: false });
    res.json({ ok: true });
  } catch (err) {
    console.error('Resend error:', err);
    res.status(500).json({ error: 'Could not resend email' });
  }
});

app.listen(PORT, () => console.log(`CampusFlix running on http://localhost:${PORT}`));
