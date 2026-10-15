const mongoose = require("mongoose");

// Removes any "user:password@" credentials from an error message so secrets
// are never printed to the terminal.
const hideSecrets = (text) => text.replace(/\/\/([^:@/]+):([^@/]+)@/g, "//<redacted>@");

// Connects to MongoDB using the MONGODB_URI environment variable.
// Throws an error when the URI is missing or the connection fails, so the
// caller can stop the server instead of running without a database.
const connectDB = async () => {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("MONGODB_URI is not set. Add it to your .env file.");
  }

  try {
    await mongoose.connect(uri);
    console.log("MongoDB connected successfully.");
  } catch (error) {
    console.error("Failed to connect to MongoDB:", hideSecrets(String(error.message)));
    throw error;
  }
};

module.exports = { connectDB };
