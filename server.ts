import express from "express";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import fs from "fs";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, onSnapshot, query, where, orderBy, getDocs } from "firebase/firestore";

// Initialize Firebase Client SDK
let db: any = null;
try {
  const firebaseConfigPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(firebaseConfigPath)) {
    const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf-8'));
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
  }
} catch (error) {
  console.error("Firebase initialization failed:", error);
}

const DATA_FILE = path.join(process.cwd(), 'data.json');

let products: any[] = [];
let stats = {
  activeUsers: 0,
  totalOrders: 0,
  totalRevenue: 0
};
let categories = [
  { id: '1', name: 'Mobiles', image: 'https://picsum.photos/seed/mobile/200/200' },
  { id: '2', name: 'Fashion', image: 'https://picsum.photos/seed/fashion/200/200' },
  { id: '3', name: 'Electronics', image: 'https://picsum.photos/seed/electronics/200/200' },
  { id: '4', name: 'Travel', image: 'https://picsum.photos/seed/travel/200/200' },
  { id: '5', name: 'Deals', image: 'https://picsum.photos/seed/deals/200/200' },
  { id: '6', name: 'Home', image: 'https://picsum.photos/seed/home/200/200' },
  { id: '7', name: 'Beauty', image: 'https://picsum.photos/seed/beauty/200/200' },
  { id: '8', name: 'Appliances', image: 'https://picsum.photos/seed/appliances/200/200' }
];
let sliders = [
  { id: '1', image: 'https://picsum.photos/seed/amazonhero/1500/600', link: '#' },
  { id: '2', image: 'https://picsum.photos/seed/amazonhero2/1500/600', link: '#' },
  { id: '3', image: 'https://picsum.photos/seed/amazonhero3/1500/600', link: '#' }
];
let resellers: { email: string, password: string, isBanned: boolean }[] = [];
let resellerEarnings: { id: string, email: string, amount: number, description: string, date: string, status: 'pending' | 'completed' }[] = [];
let resellerWithdrawals: { id: string, email: string, amount: number, upiId: string, date: string, status: 'pending' | 'completed' | 'rejected' }[] = [];

if (fs.existsSync(DATA_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    if (data.products) products = data.products;
    if (data.stats) stats = { ...stats, ...data.stats, activeUsers: 0 };
    if (data.categories) categories = data.categories;
    if (data.sliders) sliders = data.sliders;
    if (data.resellerEarnings) resellerEarnings = data.resellerEarnings;
    if (data.resellerWithdrawals) resellerWithdrawals = data.resellerWithdrawals;
    if (data.resellers) {
      resellers = data.resellers;
    } else if (data.resellerPasswords) {
      resellers = data.resellerPasswords.map((p: any) => typeof p === 'string' ? { email: `user${Math.floor(Math.random()*1000)}@gmail.com`, password: p, isBanned: false } : p);
    }
  } catch (e) {
    console.error("Failed to load data.json", e);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ products, stats, categories, sliders, resellers, resellerEarnings, resellerWithdrawals }, null, 2));
  } catch (e) {
    console.error("Failed to save data.json", e);
  }
}

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  const PORT = process.env.PORT || 3000;

  app.use(express.json());

  app.get("/health", (req, res) => {
    res.json({ 
      status: "ok", 
      mode: process.env.NODE_ENV,
      port: PORT,
      firebaseAdmin: !!db
    });
  });

  // Listen to Firestore for orders to update stats in real-time (Global listener)
  if (db) {
    onSnapshot(collection(db, 'orders'), (snapshot) => {
      let totalOrders = 0;
      let totalRevenue = 0;
      snapshot.forEach(doc => {
        const data = doc.data();
        totalOrders++;
        totalRevenue += data.total || 0;
      });
      stats.totalOrders = totalOrders;
      stats.totalRevenue = totalRevenue;
      io.emit("stats_update", stats);
      saveData();
    }, (error) => {
      console.error("Firestore onSnapshot error:", error);
    });
  }

  io.on("connection", (socket) => {
    stats.activeUsers++;
    io.emit("stats_update", stats);
    socket.emit("initial_data", { products, stats, categories, sliders, resellers, resellerEarnings, resellerWithdrawals });

    socket.on("add_reseller", (data: { email: string, password: string }) => {
      if (!resellers.find(r => r.email === data.email)) {
        resellers.push({ email: data.email, password: data.password, isBanned: false });
        saveData();
        io.emit("resellers_update", resellers);
      }
    });

    socket.on("delete_reseller", (email: string) => {
      resellers = resellers.filter(r => r.email !== email);
      saveData();
      io.emit("resellers_update", resellers);
    });

    socket.on("toggle_ban_reseller", (email: string) => {
      const reseller = resellers.find(r => r.email === email);
      if (reseller) {
        reseller.isBanned = !reseller.isBanned;
        saveData();
        io.emit("resellers_update", resellers);
      }
    });

    socket.on("verify_reseller", (data: { email: string, password: string }, callback) => {
      const reseller = resellers.find(r => r.email === data.email && r.password === data.password);
      if (reseller) {
        if (reseller.isBanned) {
          callback({ success: false, message: 'This account has been banned.' });
        } else {
          const earnings = resellerEarnings.filter(e => e.email === data.email);
          callback({ success: true, earnings });
        }
      } else {
        callback({ success: false, message: 'Invalid email or password.' });
      }
    });

    socket.on("add_reseller_earning", (data: { email: string, amount: number, description: string }) => {
      const newEarning = {
        id: Date.now().toString(),
        email: data.email,
        amount: data.amount,
        description: data.description,
        date: new Date().toISOString(),
        status: 'pending' as const
      };
      resellerEarnings.push(newEarning);
      saveData();
      io.emit("reseller_earnings_update", resellerEarnings);
    });

    socket.on("update_reseller_earning_status", (data: { id: string, status: 'pending' | 'completed' }) => {
      const earning = resellerEarnings.find(e => e.id === data.id);
      if (earning) {
        earning.status = data.status;
        saveData();
        io.emit("reseller_earnings_update", resellerEarnings);
      }
    });

    socket.on("delete_reseller_earning", (id: string) => {
      resellerEarnings = resellerEarnings.filter(e => e.id !== id);
      saveData();
      io.emit("reseller_earnings_update", resellerEarnings);
    });

    socket.on("get_reseller_earnings", (email: string, callback) => {
      const earnings = resellerEarnings.filter(e => e.email === email);
      const withdrawals = resellerWithdrawals.filter(w => w.email === email);
      callback({ earnings, withdrawals });
    });

    socket.on("get_reseller_orders", async (email: string, callback) => {
      console.log(`[get_reseller_orders] Request received for email: ${email}`);
      if (!db) {
        console.error("[get_reseller_orders] DB not initialized");
        return callback([]);
      }
      try {
        const q = query(
          collection(db, 'orders'),
          where('resellerEmail', '==', email)
        );
        const snapshot = await getDocs(q);
        console.log(`[get_reseller_orders] Found ${snapshot.docs.length} orders for ${email}`);
        const orders = snapshot.docs.map(doc => {
          const data = doc.data();
          let dateStr = new Date().toISOString();
          if (data.createdAt) {
            if (typeof data.createdAt.toDate === 'function') {
              dateStr = data.createdAt.toDate().toISOString();
            } else if (typeof data.createdAt === 'string' || typeof data.createdAt === 'number') {
              dateStr = new Date(data.createdAt).toISOString();
            }
          }
          return {
            id: doc.id,
            ...data,
            date: dateStr
          };
        });
        
        // Sort in memory to avoid requiring a composite index in Firestore
        orders.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        
        callback(orders);
      } catch (error) {
        console.error("Error fetching reseller orders:", error);
        callback([]);
      }
    });

    socket.on("request_withdrawal", (data: { email: string, amount: number, upiId: string }, callback) => {
      const earnings = resellerEarnings.filter(e => e.email === data.email && e.status === 'completed');
      const withdrawals = resellerWithdrawals.filter(w => w.email === data.email && w.status !== 'rejected');
      
      const totalEarnings = earnings.reduce((sum, e) => sum + e.amount, 0);
      const totalWithdrawn = withdrawals.reduce((sum, w) => sum + w.amount, 0);
      const availableBalance = totalEarnings - totalWithdrawn;

      if (data.amount > availableBalance) {
        return callback({ success: false, message: 'Insufficient balance' });
      }

      const newWithdrawal = {
        id: Date.now().toString(),
        email: data.email,
        amount: data.amount,
        upiId: data.upiId,
        date: new Date().toISOString(),
        status: 'pending' as const
      };
      resellerWithdrawals.push(newWithdrawal);
      saveData();
      io.emit("reseller_withdrawals_update", resellerWithdrawals);
      callback({ success: true });
    });

    socket.on("update_withdrawal_status", (data: { id: string, status: 'pending' | 'completed' | 'rejected' }) => {
      const withdrawal = resellerWithdrawals.find(w => w.id === data.id);
      if (withdrawal) {
        withdrawal.status = data.status;
        saveData();
        io.emit("reseller_withdrawals_update", resellerWithdrawals);
      }
    });

    socket.on("delete_withdrawal", (id: string) => {
      resellerWithdrawals = resellerWithdrawals.filter(w => w.id !== id);
      saveData();
      io.emit("reseller_withdrawals_update", resellerWithdrawals);
    });

    socket.on("add_product", (product) => {
      const newProduct = { ...product, id: Date.now() };
      products.push(newProduct);
      saveData();
      io.emit("products_update", products);
    });

    socket.on("delete_product", (id) => {
      products = products.filter(p => p.id !== id);
      saveData();
      io.emit("products_update", products);
    });

    socket.on("edit_product", (updatedProduct) => {
      const index = products.findIndex(p => p.id === updatedProduct.id);
      if (index !== -1) {
        products[index] = updatedProduct;
        saveData();
        io.emit("products_update", products);
      }
    });

    socket.on("place_order", (orderData) => {
      // Stats are now updated via Firestore onSnapshot
    });

    socket.on("add_category", (category) => {
      const newCategory = { ...category, id: Date.now().toString() };
      categories.push(newCategory);
      saveData();
      io.emit("categories_update", categories);
    });

    socket.on("delete_category", (id) => {
      categories = categories.filter(c => c.id !== id);
      saveData();
      io.emit("categories_update", categories);
    });

    socket.on("add_slider", (slider) => {
      const newSlider = { ...slider, id: Date.now().toString() };
      sliders.push(newSlider);
      saveData();
      io.emit("sliders_update", sliders);
    });

    socket.on("delete_slider", (id) => {
      sliders = sliders.filter(s => s.id !== id);
      saveData();
      io.emit("sliders_update", sliders);
    });

    socket.on("disconnect", () => {
      stats.activeUsers = Math.max(0, stats.activeUsers - 1);
      io.emit("stats_update", stats);
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    
    // Explicit fallback for SPA in dev mode
    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        let template = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    } else {
      app.get('*', (req, res) => {
        res.status(500).send("Production build not found. Please run 'npm run build' before starting the server.");
      });
    }
  }

  httpServer.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
