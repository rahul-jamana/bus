const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  studentId: { type: String, required: true },
  studentName: { type: String, required: true },
  parentName: { type: String, default: '' },
  email: { type: String, default: '' },
  phoneNumber: { type: String, default: '' },
  whatsappNumber: { type: String, default: '' },
  channel: { type: String, required: true, enum: ['Email', 'WhatsApp', 'SMS'] },
  subject: { type: String, default: '' },
  message: { type: String, required: true },
  status: { type: String, required: true, enum: ['Sent', 'Failed', 'Pending'], default: 'Sent' },
  errorMessage: { type: String, default: '' },
  date: { type: String, required: true },
  time: { type: String, required: true },
  timestamp: { type: Number, default: () => Date.now() },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
