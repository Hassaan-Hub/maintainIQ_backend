require("dotenv").config();
const app = require("./src/app");
const { connectDB } = require("./src/config/db");
const dns = require("dns");

// Use Cloudflare's DNS servers so MongoDB Atlas SRV lookups work on networks
// where the default resolver cannot find the cluster.
dns.setServers(["1.1.1.1"]);

const PORT = process.env.PORT || 3000;

// Starts the server only after the database connection succeeds. If MongoDB
// is unreachable we log it and exit instead of pretending the API is ready.
const startServer = async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server stopped: cannot start without a database connection.");
    process.exit(1);
  }
};

startServer();
