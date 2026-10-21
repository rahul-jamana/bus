const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  studentId: { type: String, required: true },
  name: { type: String, required: true },
  rollNumber: { type: String, required: true },
  branch: { type: String },
  semester: { type: String },
  date: { type: String, required: true }, // Format: YYYY-MM-DD
  time: { type: String, required: true }, // Format: HH:MM:SS AM/PM
  timestamp: { type: Number, required: true },
  status: { type: String, enum: ['Present', 'Late', 'Early', 'Absent', 'Check-Out'], required: true },
  device: { type: String, default: 'Webcam' },
  confidence: { type: Number, default: 95.0 },
  locationLat: { type: Number },
  locationLng: { type: Number },
  createdAt: { type: Date, default: Date.now }
});

// Index to quickly check duplicate attendance per student per day
attendanceSchema.index({ studentId: 1, date: 1, status: 1 });

module.exports = mongoose.models.Attendance || mongoose.model('Attendance', attendanceSchema);
