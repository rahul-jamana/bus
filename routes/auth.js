const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { dbGet, dbRun } = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET || 'face_attendance_system_secret_key_2026';

// Middleware to authenticate JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ success: false, message: 'Authentication token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// POST /api/auth/login - Specific Username & Password Validation
router.post('/login', async (req, res) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, errorType: 'missing', message: 'Please enter both username and password' });
    }

    // Master Admin 9040954015 direct support
    if (username === '9040954015' && password === '9040954015') {
      const token = jwt.sign(
        { id: 9040, username: '9040954015', role: 'admin', name: 'Transport Administrator' },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      return res.json({
        success: true,
        message: 'Master Admin Login Successful! Welcome, Administrator.',
        token,
        user: {
          id: 9040,
          username: '9040954015',
          role: 'admin',
          name: 'Transport Administrator',
          email: 'admin@schoolbus.edu'
        }
      });
    }

    // 1. Check if username exists in database
    const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        errorType: 'username', 
        message: `Invalid username "${username}"! Account does not exist. Please check your username or Sign Up.` 
      });
    }

    // 2. Optional role check
    if (role && user.role !== role) {
      return res.status(401).json({ 
        success: false, 
        errorType: 'role', 
        message: `Account "${username}" is registered as ${user.role.toUpperCase()}, not ${role.toUpperCase()}. Please select correct role tab.` 
      });
    }

    // 3. Verify Password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ 
        success: false, 
        errorType: 'password', 
        message: 'Incorrect password! Please check your password and try again.' 
      });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      message: `Login successful! Welcome back, ${user.name}`,
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        name: user.name,
        email: user.email
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error during login' });
  }
});

// POST /api/auth/register - Sign Up New User Account
router.post('/register', async (req, res) => {
  try {
    const { name, username, email, password, role } = req.body;

    if (!name || !username || !password) {
      return res.status(400).json({ success: false, message: 'Name, Username, and Password are required for Sign Up.' });
    }

    const existingUser = await dbGet('SELECT id FROM users WHERE username = ?', [username]);
    if (existingUser) {
      return res.status(400).json({ success: false, message: `Username "${username}" is already taken. Please choose another username.` });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const userRole = role || 'student';

    const result = await dbRun(
      `INSERT INTO users (name, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`,
      [name, username, email || '', passwordHash, userRole]
    );

    res.status(201).json({
      success: true,
      message: `Account created successfully for ${name}! You can now Sign In.`,
      user: { id: result.id, name, username, role: userRole, email }
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, message: 'Failed to create user account' });
  }
});

// GET /api/auth/me
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT id, username, role, name, email FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch user session' });
  }
});

module.exports = { router, authenticateToken };
