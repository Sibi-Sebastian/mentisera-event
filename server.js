require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const mysql = require('mysql2');

const app = express();
const PORT = process.env.PORT || 3000;

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Connect to MySQL
const mysqlPool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE
}).promise();

// Define MongoDB Schema
const UserSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  domain: String,
  whatsapp: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);

// Security middleware
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

// CORS configuration
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// PhonePe Configuration
const PHONEPE_CONFIG = {
  merchantId: process.env.MERCHANT_ID,
  saltKey: process.env.SALT_KEY,
  saltIndex: process.env.SALT_INDEX || 1,
  baseUrl: process.env.PHONEPE_ENV === 'production' 
    ? 'https://api.phonepe.com/apis/hermes' 
    : 'https://api-preprod.phonepe.com/apis/merchant-simulator'
};

// Generate X-VERIFY header
function generateSignature(base64Payload) {
  const hash = crypto.createHash('sha256')
    .update(base64Payload + PHONEPE_CONFIG.saltKey)
    .digest('hex');
  return hash + '###' + PHONEPE_CONFIG.saltIndex;
}

// **User Registration Endpoint (MongoDB)**
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, phone, domain, whatsapp } = req.body;

    // Save user data to MongoDB
    const newUser = new User({ name, email, phone, domain, whatsapp });
    await newUser.save();

    res.json({ success: true, message: 'User registered successfully' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, message: 'User registration failed' });
  }
});

// **Payment Endpoint**
app.post('/api/create-payment', async (req, res) => {
  try {
    const { name, email, domain, phone, whatsapp, amount } = req.body;

    // Generate transaction ID
    const transactionId = 'MT' + Date.now();
    
    // Save payment data in MySQL
    const sql = `INSERT INTO payments (transaction_id, name, email, phone, domain, whatsapp, amount, status, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', NOW())`;

    await mysqlPool.execute(sql, [transactionId, name, email, phone, domain, whatsapp, amount || 20000]);

    // Prepare payment payload
    const paymentData = {
      merchantId: PHONEPE_CONFIG.merchantId,
      merchantTransactionId: transactionId,
      merchantUserId: 'MU' + crypto.randomBytes(8).toString('hex'),
      amount: amount || 20000,
      redirectUrl: `http://localhost:${PORT}/payment-success`,
      redirectMode: 'POST',
      callbackUrl: `http://localhost:${PORT}/payment-callback`,
      paymentInstrument: {
        type: 'PAY_PAGE'
      },
      metadata: { name, email, domain, phone, whatsapp }
    };

    const base64Payload = Buffer.from(JSON.stringify(paymentData)).toString('base64');
    const xVerifyHeader = generateSignature(base64Payload);

    // Send request to PhonePe
    const response = await axios.post(`${PHONEPE_CONFIG.baseUrl}/pg/v1/pay`, {
      request: base64Payload
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerifyHeader,
        'X-MERCHANT-ID': PHONEPE_CONFIG.merchantId
      }
    });

    res.json({
      success: true,
      paymentUrl: response.data.data.instrumentResponse.redirectInfo.url
    });

  } catch (error) {
    console.error('Payment error:', error.response?.data || error.message);
    res.status(500).json({ success: false, message: 'Payment processing failed' });
  }
});

// **Payment Callback**
app.post('/payment-callback', async (req, res) => {
  try {
    const { response, transactionId } = req.body;
    const xVerifyHeader = generateSignature(response);

    const verificationResponse = await axios.get(
      `${PHONEPE_CONFIG.baseUrl}/pg/v1/status/${PHONEPE_CONFIG.merchantId}/${transactionId}`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': xVerifyHeader,
          'X-MERCHANT-ID': PHONEPE_CONFIG.merchantId
        }
      }
    );

    if (verificationResponse.data.code === 'PAYMENT_SUCCESS') {
      // Update payment status in MySQL
      const updateSql = `UPDATE payments SET status = 'SUCCESS' WHERE transaction_id = ?`;
      await mysqlPool.execute(updateSql, [transactionId]);

      console.log('Payment verified:', verificationResponse.data);
      res.sendStatus(200);
    } else {
      console.log('Payment verification failed:', verificationResponse.data);
      res.sendStatus(400);
    }
  } catch (error) {
    console.error('Callback error:', error);
    res.sendStatus(500);
  }
});

// Payment success page
app.get('/payment-success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'payment-success.html'));
});

// Serve index page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
