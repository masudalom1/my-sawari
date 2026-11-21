import mongoose from "mongoose";
import dns from "dns";

// const connectDB = async () => {
//   try {
//     const conn = await mongoose.connect(process.env.MONGO_URI, {
//       autoIndex: false,
//     });

//     console.log(`MongoDB Connected: ${conn.connection.host}`);
//   } catch (error) {
//     console.error("MongoDB connection failed:", error.message);
//     process.exit(1);
//   }
// };

dns.setServers(["8.8.8.8", "1.1.1.1"]);

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      autoIndex: false,
      maxPoolSize: 50,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });

    mongoose.connection.on('disconnected', () => console.warn('⚠️  MongoDB disconnected — the driver will reconnect automatically.'));
    mongoose.connection.on('reconnected', () => console.log('🟢 MongoDB reconnected'));
    mongoose.connection.on('error', (err) => console.error('MongoDB error:', err.message));

    console.log(`MongoDB Connected: ${conn.connection.host}`);

    const mongoDnsServers = process.env.MONGO_DNS_SERVERS
    ?.split(",")
    .map((server) => server.trim())
    .filter(Boolean);

  if (mongoDnsServers?.length) {
    dns.setServers(mongoDnsServers);
  }

  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  }
};


export default connectDB;