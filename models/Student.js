const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  rollNumber: { type: String, required: true, unique: true },
  registrationNumber: { type: String, required: true, unique: true },
  branch: { type: String, required: true },
  semester: { type: String, required: true },
  section: { type: String, required: true },
  mobile: { type: String, required: true },
  email: { type: String, required: true },
  address: { type: String, default: '' },
  parentName: { type: String, default: '' },
  parentMobile: { type: String, default: '' },
  parentWhatsapp: { type: String, default: '' },
  parentEmail: { type: String, default: '' },
  emergencyContact: { type: String, default: '' },
  photoPath: { type: String, default: '' },
  posePhotos: [{ type: String }],
  faceEncoding: [{ type: Number }], // Array of numbers representing face descriptor
  descriptors: [[Number]], // Multi-pose face descriptors
  faceEnrolled: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Student || mongoose.model('Student', studentSchema);
