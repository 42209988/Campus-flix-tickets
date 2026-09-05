// CampusFlix — single-file backend.
// Data lives in MongoDB Atlas (free tier) so it survives redeploys and
// restarts — Render's free hosting wipes local files on every restart,
// so nothing here is written to disk. Poster images are stored as base64
// directly inside each show's database record, for the same reason.

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const { nanoid } = require('nanoid');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Database — MongoDB Atlas. Connected once at startup; the server only
// starts accepting requests once this succeeds (see start() at the bottom).
// ---------------------------------------------------------------------------
const client = new MongoClient(process.env.MONGODB_URI);
let db;

// True if the show's date+time hasn't passed yet — used to auto-hide
// events from the public site once they're over, no manual cleanup needed.
function isUpcoming(show) {
  if (!show.date) return true;
  const eventDateTime = new Date(`${show.date}T${show.time || '23:59'}:00`);
  return eventDateTime.getTime() > Date.now();
}

const Shows = {
  all: () => db.collection('shows').find({}).sort({ createdAt: -1 }).toArray(),
  published: async () => (await Shows.all()).filter(s => s.status === 'live' && isUpcoming(s)),
  find: id => db.collection('shows').findOne({ id }),
  create: async show => { await db.collection('shows').insertOne(show); return show; },
  update: async (id, updates) => { await db.collection('shows').updateOne({ id }, { $set: updates }); return Shows.find(id); },
  delete: id => db.collection('shows').deleteOne({ id }),
  incrementSold: async (id, qty) => {
    const s = await Shows.find(id);
    if (!s) return;
    return Shows.update(id, { sold: (s.sold || 0) + qty });
  }
};

const Tickets = {
  all: () => db.collection('tickets').find({}).sort({ createdAt: -1 }).toArray(),
  find: id => db.collection('tickets').findOne({ id }),
  findByCheckoutRef: ref => db.collection('tickets').findOne({ checkoutRequestId: ref }),
  create: async t => { await db.collection('tickets').insertOne(t); return t; },
  update: async (id, updates) => { await db.collection('tickets').updateOne({ id }, { $set: updates }); return Tickets.find(id); }
};

const Referrals = {
  all: () => db.collection('referrals').find({}).sort({ createdAt: -1 }).toArray(),
  find: id => db.collection('referrals').findOne({ id }),
  create: async r => { await db.collection('referrals').insertOne(r); return r; },
  update: async (id, updates) => { await db.collection('referrals').updateOne({ id }, { $set: updates }); return Referrals.find(id); },
  delete: id => db.collection('referrals').deleteOne({ id })
};

const Registrations = {
  all: () => db.collection('registrations').find({}).sort({ createdAt: -1 }).toArray(),
  find: id => db.collection('registrations').findOne({ id }),
  forShow: showId => db.collection('registrations').find({ showId }).sort({ createdAt: -1 }).toArray(),
  create: async r => { await db.collection('registrations').insertOne(r); return r; }
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
    doc.text(`Date: ${show.date}   Time: ${show.time}${show.duration ? '   Duration: ' + show.duration : ''}`);

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

// Builds a simple PDF confirmation for a free registration (no payment info).
function generateRegistrationPDF({ registration, show }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, doc.page.width, 90).fill('#0b0908');
    doc.fillColor('#c31f2a').font('Helvetica-Bold').fontSize(22).text('CAMPUS', 40, 32, { continued: true });
    doc.fillColor('#ffffff').text('FLIX');
    doc.fillColor('#e6ab35').font('Helvetica').fontSize(10).text('REGISTRATION CONFIRMATION', 40, 62);

    doc.moveDown(3);
    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(20).text(show.title, 40, 120);
    doc.font('Helvetica').fontSize(11).fillColor('#444444');
    doc.moveDown(0.5);
    doc.text(`Category: ${show.type}`);
    doc.text(`Venue: ${show.venue}`);
    doc.text(`Date: ${show.date}   Time: ${show.time}${show.duration ? '   Duration: ' + show.duration : ''}`);

    doc.moveDown(1);
    doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).dash(3, { space: 3 }).strokeColor('#999999').stroke();
    doc.undash();
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Registered Name');
    doc.font('Helvetica').fontSize(11).fillColor('#444444').text(registration.name);
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Phone');
    doc.font('Helvetica').fontSize(11).fillColor('#444444').text(registration.phone);
    if (registration.note) {
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Performance / Note');
      doc.font('Helvetica').fontSize(11).fillColor('#444444').text(registration.note);
    }
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Entry');
    doc.font('Helvetica').fontSize(11).fillColor('#444444').text('Free');
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Confirmation No.');
    doc.font('Helvetica').fontSize(11).fillColor('#444444').text(registration.id.toUpperCase());

    doc.moveDown(1.5);
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#888888')
      .text('Please arrive a little early. This confirmation is proof of your registration.', { width: doc.page.width - 80 });

    doc.end();
  });
}

// Builds a PDF list of everyone registered for a show — for the admin to
// download, print, or check people off at the door.
function generateRegistrantsListPDF({ show, registrants }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, doc.page.width, 80).fill('#0b0908');
    doc.fillColor('#c31f2a').font('Helvetica-Bold').fontSize(20).text('CAMPUS', 40, 26, { continued: true });
    doc.fillColor('#ffffff').text('FLIX');
    doc.fillColor('#e6ab35').font('Helvetica').fontSize(10).text('REGISTRANTS LIST', 40, 54);

    doc.moveDown(3.5);
    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(16).text(show.title, 40, 105);
    doc.font('Helvetica').fontSize(10).fillColor('#555555').text(`${show.venue} · ${show.date} · ${show.time}`);
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333333').text(`Total registered: ${registrants.length}`);
    doc.moveDown(1);

    doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(0.5);

    registrants.forEach((r, i) => {
      if (doc.y > doc.page.height - 80) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111').text(`${i + 1}. ${r.name}`, { continued: false });
      doc.font('Helvetica').fontSize(10).fillColor('#555555').text(`   ${r.phone}${r.email ? '  ·  ' + r.email : ''}`);
      if (r.note) doc.font('Helvetica-Oblique').fontSize(9.5).fillColor('#777777').text(`   "${r.note}"`);
      doc.moveDown(0.6);
    });

    doc.end();
  });
}

// Emails a PDF attachment using Brevo's HTTP API.
// (Not SMTP — Render's free tier blocks outbound SMTP ports, but regular
// HTTPS requests like this go through fine.)
async function sendPdfEmail({ to, name, subject, text, pdfBuffer, filename }) {
  console.log(`[email] Sending "${subject}" to: "${to}" from: "${process.env.EMAIL_USER}"`);

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      'accept': 'application/json'
    },
    body: JSON.stringify({
      sender: { email: process.env.EMAIL_USER, name: 'CampusFlix' },
      to: [{ email: to, name }],
      subject,
      textContent: text,
      attachment: [{ content: pdfBuffer.toString('base64'), name: filename }]
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[email] Brevo error (${res.status}):`, JSON.stringify(data));
    throw new Error(data.message || `Brevo send failed with status ${res.status}`);
  }
  console.log(`[email] Sent. messageId=${data.messageId}`);
}

async function sendTicketEmail({ to, name, show, pdfBuffer }) {
  return sendPdfEmail({
    to, name,
    subject: `Your CampusFlix Ticket — ${show.title}`,
    text: `Hi ${name},\n\nYour ticket for ${show.title} is attached as a PDF. See you there!\n\n— CampusFlix`,
    pdfBuffer,
    filename: `campusflix-ticket-${show.title.replace(/\s+/g, '-').toLowerCase()}.pdf`
  });
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

// Posters are kept in memory just long enough to convert to base64 and save
// in the database — nothing is written to local disk (it wouldn't survive
// a restart on Render's free tier anyway).
const upload = multer({
  storage: multer.memoryStorage(),
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
const publicShowFields = ({ id, title, description, type, venue, date, time, duration, price, capacity, sold, posterUrl, entryType }) =>
  ({ id, title, description, type, venue, date, time, duration, price, capacity, sold, posterUrl, entryType: entryType || 'ticket' });

app.get('/api/shows', async (req, res) => {
  const shows = await Shows.published();
  res.json(shows.map(publicShowFields));
});

app.get('/api/shows/admin/all', requireAdmin, async (req, res) => res.json(await Shows.all()));

app.get('/api/shows/:id', async (req, res) => {
  const show = await Shows.find(req.params.id);
  if (!show || show.status !== 'live' || !isUpcoming(show)) return res.status(404).json({ error: 'Show not found' });
  res.json(publicShowFields(show));
});

app.post('/api/shows/admin', requireAdmin, upload.single('poster'), async (req, res) => {
  const { title, description, type, venue, date, time, duration, price, capacity, status, entryType } = req.body;
  const isRegistration = entryType === 'registration';
  if (!title || !venue || !date || !time || !capacity || (!isRegistration && !price)) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const show = {
    id: nanoid(10), title, description: description || '', type: type || 'Film Screening',
    venue, date, time, duration: duration || '',
    entryType: isRegistration ? 'registration' : 'ticket',
    price: isRegistration ? 0 : Number(price),
    capacity: Number(capacity), sold: 0,
    posterUrl: req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : null,
    status: status === 'draft' ? 'draft' : 'live', createdAt: new Date().toISOString()
  };
  await Shows.create(show);
  res.status(201).json(show);
});

app.put('/api/shows/admin/:id', requireAdmin, upload.single('poster'), async (req, res) => {
  const updates = { ...req.body };
  if (updates.price) updates.price = Number(updates.price);
  if (updates.capacity) updates.capacity = Number(updates.capacity);
  if (req.file) updates.posterUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  const updated = await Shows.update(req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Show not found' });
  res.json(updated);
});

app.delete('/api/shows/admin/:id', requireAdmin, async (req, res) => { await Shows.delete(req.params.id); res.json({ ok: true }); });

// ---------------------------------------------------------------------------
// Free registrations — for events like competitions where people sign up
// without paying. No M-Pesa — just a free PDF confirmation.
// ---------------------------------------------------------------------------
app.post('/api/registrations', async (req, res) => {
  try {
    const { showId, name, phone, email, note } = req.body;
    if (!showId || !name || !phone) return res.status(400).json({ error: 'Missing name, phone, or event' });

    const show = await Shows.find(showId);
    if (!show || show.status !== 'live' || !isUpcoming(show) || show.entryType !== 'registration') {
      return res.status(404).json({ error: 'Event not found' });
    }

    const remaining = show.capacity - (show.sold || 0);
    if (remaining <= 0) return res.status(400).json({ error: 'Registration is full' });

    const registration = await Registrations.create({
      id: nanoid(10), showId, name, phone, email: email || '', note: note || '',
      createdAt: new Date().toISOString()
    });
    await Shows.incrementSold(showId, 1);

    // Email the confirmation PDF if they gave an email — but don't let a
    // failed send block the registration itself, which already succeeded.
    if (email) {
      try {
        const pdfBuffer = await generateRegistrationPDF({ registration, show });
        await sendPdfEmail({
          to: email, name,
          subject: `You're Registered — ${show.title}`,
          text: `Hi ${name},\n\nYour registration for ${show.title} is confirmed. Your confirmation is attached as a PDF.\n\n— CampusFlix`,
          pdfBuffer,
          filename: `campusflix-registration-${show.title.replace(/\s+/g, '-').toLowerCase()}.pdf`
        });
      } catch (emailErr) {
        console.error('Registration email error:', emailErr);
      }
    }

    res.status(201).json({ registrationId: registration.id });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Could not complete registration. Please try again.' });
  }
});

app.get('/api/registrations/:id', async (req, res) => {
  const registration = await Registrations.find(req.params.id);
  if (!registration) return res.status(404).json({ error: 'Registration not found' });
  res.json({ registration, show: await Shows.find(registration.showId) });
});

// Lets a registrant download their own confirmation PDF directly, regardless
// of whether email delivery worked.
app.get('/api/registrations/:id/pdf', async (req, res) => {
  const registration = await Registrations.find(req.params.id);
  if (!registration) return res.status(404).json({ error: 'Registration not found' });
  const show = await Shows.find(registration.showId);
  const pdfBuffer = await generateRegistrationPDF({ registration, show });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="campusflix-registration-${registration.id}.pdf"`);
  res.send(pdfBuffer);
});

app.get('/api/registrations/admin/for-show/:showId', requireAdmin, async (req, res) => {
  res.json(await Registrations.forShow(req.params.showId));
});

// Admin download: full PDF list of everyone registered for a show.
app.get('/api/registrations/admin/for-show/:showId/pdf', requireAdmin, async (req, res) => {
  const show = await Shows.find(req.params.showId);
  if (!show) return res.status(404).json({ error: 'Show not found' });
  const registrants = await Registrations.forShow(req.params.showId);
  const pdfBuffer = await generateRegistrantsListPDF({ show, registrants });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="registrants-${show.title.replace(/\s+/g, '-').toLowerCase()}.pdf"`);
  res.send(pdfBuffer);
});



// ---------------------------------------------------------------------------
// Ticket / payment routes
// ---------------------------------------------------------------------------
app.post('/api/tickets/purchase', async (req, res) => {
  try {
    const { showId, name, phone, email, quantity, refCode } = req.body;
    const qty = Number(quantity) || 1;
    if (!showId || !name || !phone || !email) return res.status(400).json({ error: 'Missing name, phone, email, or show' });

    const show = await Shows.find(showId);
    if (!show || show.status !== 'live' || !isUpcoming(show)) return res.status(404).json({ error: 'Show not found' });

    const remaining = show.capacity - (show.sold || 0);
    if (qty > remaining) return res.status(400).json({ error: `Only ${remaining} tickets left` });

    // Only honor a referral code if it actually exists and matches this show —
    // an invalid/old code is silently ignored rather than blocking the purchase.
    const referral = refCode ? await Referrals.find(refCode) : null;
    const validRefCode = (referral && referral.showId === showId) ? referral.id : null;

    const amount = show.price * qty;
    const ticket = await Tickets.create({
      id: nanoid(12), showId, name, phone, email, quantity: qty, amount, refCode: validRefCode,
      status: 'pending', checkoutRequestId: null, createdAt: new Date().toISOString()
    });

    const stk = await initiateSTKPush({ phone, amount, accountReference: 'CampusFlix', description: show.title });
    await Tickets.update(ticket.id, { checkoutRequestId: stk.CheckoutRequestID });

    res.json({ ticketId: ticket.id, status: 'pending' });
  } catch (err) {
    console.error('Purchase error:', err);
    res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

app.get('/api/tickets/:id/status', async (req, res) => {
  const ticket = await Tickets.find(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ status: ticket.status, emailError: ticket.emailError || false });
});

app.get('/api/tickets/:id', async (req, res) => {
  const ticket = await Tickets.find(req.params.id);
  if (!ticket || ticket.status !== 'paid') return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket, show: await Shows.find(ticket.showId) });
});

// Safaricom calls this directly after the buyer approves/declines — no auth.
app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const stkCallback = req.body?.Body?.stkCallback;
    if (!stkCallback) return res.status(400).json({ error: 'Malformed callback' });

    const { CheckoutRequestID, ResultCode } = stkCallback;
    const ticket = await Tickets.findByCheckoutRef(CheckoutRequestID);
    if (!ticket) { console.warn('No ticket for', CheckoutRequestID); return res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); }

    if (ResultCode === 0) {
      await Tickets.update(ticket.id, { status: 'paid' });
      await Shows.incrementSold(ticket.showId, ticket.quantity);

      // Build the PDF and email it. If email fails, the ticket is still
      // valid/paid — we just flag it so the confirmation page can offer a retry.
      try {
        const show = await Shows.find(ticket.showId);
        const pdfBuffer = await generateReceiptPDF({ ticket, show });
        await sendTicketEmail({ to: ticket.email, name: ticket.name, show, pdfBuffer });
      } catch (emailErr) {
        console.error('Email send error:', emailErr);
        await Tickets.update(ticket.id, { emailError: true });
      }
    } else {
      await Tickets.update(ticket.id, { status: 'failed' });
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
    const ticket = await Tickets.find(req.params.id);
    if (!ticket || ticket.status !== 'paid') return res.status(404).json({ error: 'Ticket not found' });
    const show = await Shows.find(ticket.showId);
    const pdfBuffer = await generateReceiptPDF({ ticket, show });
    await sendTicketEmail({ to: ticket.email, name: ticket.name, show, pdfBuffer });
    await Tickets.update(ticket.id, { emailError: false });
    res.json({ ok: true });
  } catch (err) {
    console.error('Resend error:', err);
    res.status(500).json({ error: 'Could not resend email' });
  }
});

// ---------------------------------------------------------------------------
// Referral links — admin creates one per person per show, buyers who use
// the link get tracked, and the admin sees & manually pays commission owed.
// ---------------------------------------------------------------------------

app.post('/api/referrals/admin', requireAdmin, async (req, res) => {
  const { name, phone, showId, commissionPercent } = req.body;
  if (!name || !phone || !showId || commissionPercent === undefined) {
    return res.status(400).json({ error: 'Missing name, phone, show, or commission percentage' });
  }
  const show = await Shows.find(showId);
  if (!show) return res.status(404).json({ error: 'Show not found' });

  const referral = await Referrals.create({
    id: nanoid(8), name, phone, showId,
    commissionPercent: Number(commissionPercent),
    paidAmount: 0,
    createdAt: new Date().toISOString()
  });
  res.status(201).json(referral);
});

app.get('/api/referrals/admin/all', requireAdmin, async (req, res) => {
  const referrals = await Referrals.all();
  const tickets = (await Tickets.all()).filter(t => t.status === 'paid');
  const shows = await Shows.all();

  const withStats = referrals.map(r => {
    const refTickets = tickets.filter(t => t.refCode === r.id);
    const totalSales = refTickets.reduce((sum, t) => sum + t.amount, 0);
    const ticketsSold = refTickets.reduce((sum, t) => sum + t.quantity, 0);
    const commissionEarned = Math.round(totalSales * (r.commissionPercent / 100));
    const owed = commissionEarned - (r.paidAmount || 0);
    const show = shows.find(s => s.id === r.showId);
    return { ...r, showTitle: show ? show.title : '(deleted show)', ticketsSold, totalSales, commissionEarned, owed };
  });

  res.json(withStats);
});

app.post('/api/referrals/admin/:id/mark-paid', requireAdmin, async (req, res) => {
  const referral = await Referrals.find(req.params.id);
  if (!referral) return res.status(404).json({ error: 'Referral not found' });
  const amount = Number(req.body.amount) || 0;
  const updated = await Referrals.update(referral.id, { paidAmount: (referral.paidAmount || 0) + amount });
  res.json(updated);
});

app.delete('/api/referrals/admin/:id', requireAdmin, async (req, res) => {
  await Referrals.delete(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Startup — connect to MongoDB first, then start accepting requests.
// ---------------------------------------------------------------------------
async function start() {
  try {
    await client.connect();
    db = client.db('campusflix');
    console.log('Connected to MongoDB');
    app.listen(PORT, () => console.log(`CampusFlix running on http://localhost:${PORT}`));
  } catch (err) {
    console.error('Failed to connect to MongoDB. Check MONGODB_URI.', err);
    process.exit(1);
  }
}

start();
