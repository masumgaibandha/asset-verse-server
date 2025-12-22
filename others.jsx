// index.js (clean + commented where updated)

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 3000;

// -------------------- Firebase Admin (from base64 env) --------------------
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_ADMIN_B64, "base64").toString("utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// -------------------- Middleware --------------------
app.use(express.json());
app.use(cors());

// -------------------- Verify Firebase Token --------------------
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) return res.status(401).send({ message: "unauthorized access" });

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

// -------------------- MongoDB --------------------
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.xhu33ja.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("asset-verse");
    const requestsCollection = db.collection("requests");
    const packagesCollection = db.collection("packages");
    const usersCollection = db.collection("users");
    const paymentsCollection = db.collection("payments");
    const employeesCollection = db.collection("employees");

    // -------------------- Verify HR (UPDATED) --------------------
    // ✅ uses decoded email from verifyFBToken
    const verifyHR = async (req, res, next) => {
      const email = req.decoded_email;
      const user = await usersCollection.findOne({ email });

      if (!user || user.role !== "hr") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // ==================== USERS APIs ====================

    app.get("/users", verifyFBToken, async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};

      if (searchText) {
        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }

      const result = await usersCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray();

      res.send(result);
    });

    // NOTE: keep empty if you’re not using it
    app.get("/users/:id", async (req, res) => {
      res.send({ message: "not implemented" });
    });

    // ✅ role API used by useRole hook
    app.get("/users/:email/role", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send({ role: user?.role || "user" });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();

      const email = user.email;
      const userExists = await usersCollection.findOne({ email });
      if (userExists) return res.send({ message: "user exists" });

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // ✅ HR can change roles
    app.patch("/users/:id/role", verifyFBToken, verifyHR, async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } }
      );

      res.send(result);
    });

    // ==================== EMPLOYEES APIs ====================

    // ✅ UPDATED: supports status + workStatus filters (for AssignAssets)
    app.get("/employees", async (req, res) => {
      const query = {};
      const { status, workStatus } = req.query;

      if (status) query.status = status;
      if (workStatus) query.workStatus = workStatus;

      const result = await employeesCollection.find(query).sort({ createdAt: -1 }).toArray();
      res.send(result);
    });

    // ✅ UPDATED: set default workStatus on create
    app.post("/employees", async (req, res) => {
      const employee = req.body;

      employee.status = "pending";
      employee.workStatus = "inactive"; 
      employee.createdAt = new Date();

      const result = await employeesCollection.insertOne(employee);
      res.send(result);
    });

    // approve employee
    app.patch('/employees/:id', verifyFBToken, verifyHR, async (req, res) => {
      const { status, email } = req.body;
      const id = req.params.id;

      const query = { _id: new ObjectId(id) };

      const update = {
        $set: {
          status,
          approvedAt: new Date(),
          workStatus: status === "approved" ? "available" : "inactive",
        },
      };

      // ✅ THIS IS REQUIRED
      if (status === "approved") {
        update.$set.workStatus = "available";
      }
      if (status === "rejected") {
        update.$set.workStatus = "inactive";
      }

      const result = await employeesCollection.updateOne(query, update);

      // update user role
      if (status === "approved" && email) {
        await usersCollection.updateOne(
          { email },
          { $set: { role: 'employee' } }
        );
      }

      res.send(result);
    });


    app.delete("/employees/:id", async (req, res) => {
      const id = req.params.id;
      const result = await employeesCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // ==================== REQUESTS APIs ====================

    // ✅ UPDATED: supports BOTH email filter & requestStatus filter
    app.get("/requests", async (req, res) => {
      const query = {};
      const { email, requestStatus } = req.query;

      if (email) query.employeeEmail = email; // employee view
      if (requestStatus) query.requestStatus = requestStatus; // HR / Assign view

      const result = await requestsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    });

    app.post("/requests", async (req, res) => {
      const request = req.body;

      request.requestStatus = "pending";
      request.createdAt = new Date();
      request.approvalDate = null;

      const result = await requestsCollection.insertOne(request);
      res.send(result);
    });

    app.delete("/requests/:id", async (req, res) => {
      const id = req.params.id;
      const result = await requestsCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // ✅ UPDATED Assign request + set employee busy
    app.patch("/requests/:id/assign", verifyFBToken, verifyHR, async (req, res) => {
      const { employeeId, employeeName, employeeEmail } = req.body;
      const id = req.params.id;

      // 1) update request
      const requestResult = await requestsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            requestStatus: "assigned",
            assignedEmployeeId: employeeId,
            assignedEmployeeName: employeeName,
            assignedEmployeeEmail: employeeEmail,
            assignedAt: new Date(),
          },
        }
      );

      // 2) set employee busy
      const employeeResult = await employeesCollection.updateOne(
        { _id: new ObjectId(employeeId) },
        { $set: { workStatus: "busy" } }
      );

      res.send({ requestResult, employeeResult });
    });

    // 21/12/25
    // 8.58 am

    // HR updates request status (complete/returned/rejected etc.)
    app.patch("/requests/:id/status", verifyFBToken, verifyHR, async (req, res) => {
      const { requestStatus } = req.body; // "approved" | "rejected" | "returned" | "completed"
      const id = req.params.id;

      // get request to know assigned employee
      const request = await requestsCollection.findOne({ _id: new ObjectId(id) });

      const result = await requestsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            requestStatus,
            approvalDate: new Date(),
          },
        }
      );

      // if work finished, make employee available again
      if (["returned", "completed", "rejected"].includes(requestStatus) && request?.assignedEmployeeId) {
        await employeesCollection.updateOne(
          { _id: new ObjectId(request.assignedEmployeeId) },
          { $set: { workStatus: "available" } }
        );
      }

      res.send(result);
    });

    // ==================== PACKAGES APIs ====================

    app.get("/packages", async (req, res) => {
      const result = await packagesCollection.find({}).sort({ employeeLimit: 1 }).toArray();
      res.send(result);
    });

    // ==================== PAYMENTS APIs ====================

    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      if (email) {
        query.hrEmail = email;

        // ✅ security check
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }

      const result = await paymentsCollection
        .find(query)
        .sort({ paymentDate: -1 })
        .toArray();

      res.send(result);
    });

    // ==================== STRIPE APIs ====================

    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.price) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: { name: `AssetVerse Package: ${paymentInfo.packageName}` },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: paymentInfo.hrEmail,

        success_url: `${process.env.SITE_DOMAIN}/dashboard/upgrade-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/upgrade-package`,

        metadata: {
          packageId: paymentInfo.packageId,
          packageName: paymentInfo.packageName,
          employeeLimit: String(paymentInfo.employeeLimit),
        },
      });

      res.send({ url: session.url });
    });

    app.patch("/upgrade-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status !== "paid") {
        return res.send({ success: false, message: "Payment not completed" });
      }

      const hrEmail = session.customer_email;
      const packageName = session.metadata.packageName;
      const employeeLimit = Number(session.metadata.employeeLimit);

      const transactionId = session.payment_intent;

      // ✅ prevent duplicates
      const paymentExists = await paymentsCollection.findOne({ transactionId });
      if (paymentExists) {
        return res.send({ success: true, message: "Payment already recorded", transactionId });
      }

      // 1) update HR user
      const updateResult = await usersCollection.updateOne(
        { email: hrEmail, role: "hr" },
        {
          $set: {
            subscription: packageName.toLowerCase(),
            packageLimit: employeeLimit,
            updatedAt: new Date(),
          },
        }
      );

      // 2) insert payment history
      const paymentDoc = {
        hrEmail,
        packageName,
        employeeLimit,
        amount: session.amount_total / 100,
        transactionId,
        paymentDate: new Date(),
        status: "completed",
      };

      const paymentResult = await paymentsCollection.insertOne(paymentDoc);

      res.send({ success: true, transactionId, updateResult, paymentResult });
    });

    // Ping
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // await client.close();
  }
}

run().catch(console.dir);

// -------------------- Root --------------------
app.get("/", (req, res) => {
  res.send("Asset Verse Server Running");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});




// Latest

const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const admin = require("firebase-admin");
const app = express();
const port = process.env.PORT || 3000;

// -------------------- Firebase Admin --------------------
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_ADMIN_B64, "base64").toString("utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// -------------------- Middleware --------------------
app.use(express.json());
app.use(cors());

// -------------------- Auth Middlewares --------------------
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send({ message: "unauthorized access" });
  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

// -------------------- MongoDB --------------------
const uri = mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.xhu33ja.mongodb.net/?appName=Cluster0;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("asset-verse");
    const usersCollection = db.collection("users");
    const employeesCollection = db.collection("employees");
    const assetsCollection = db.collection("assets");
    const requestsCollection = db.collection("requests");
    const assignedAssetsCollection = db.collection("assignedAssets");
    const employeeAffiliationsCollection = db.collection("employeeAffiliations");
    const packagesCollection = db.collection("packages");
    const paymentsCollection = db.collection("payments");

    // -------------------- Role Middleware --------------------
    const verifyHR = async (req, res, next) => {
      const email = req.decoded_email;
      const user = await usersCollection.findOne({ email });
      if (!user || user.role !== "hr")
        return res.status(403).send({ message: "forbidden access" });
      next();
    };

    // ==================== USERS ====================
    app.get("/users", verifyFBToken, async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }
      const result = await usersCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray();
      res.send(result);
    });

    app.get("/users/me", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const user = await usersCollection.findOne({ email });
      res.send(user || {});
    });

    app.patch("/users/me", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const { displayName, photoURL } = req.body;
      const updateDoc = { $set: { updatedAt: new Date() } };
      if (displayName) updateDoc.$set.displayName = displayName;
      if (photoURL) updateDoc.$set.photoURL = photoURL;
      const result = await usersCollection.updateOne({ email }, updateDoc);
      const updatedUser = await usersCollection.findOne({ email });
      res.send({ result, user: updatedUser });
    });

    app.get("/users/:email/role", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send({ role: user?.role || "user" });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = user.role || "user";
      user.createdAt = new Date();
      const exists = await usersCollection.findOne({ email: user.email });
      if (exists) return res.send({ message: "user exists" });
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.post("/users/hr", async (req, res) => {
      const user = req.body;
      const exists = await usersCollection.findOne({ email: user.email });
      if (exists) return res.send({ message: "user exists" });
      const hrDoc = {
        email: user.email,
        displayName: user.displayName || "HR",
        photoURL: user.photoURL || "",
        role: "hr",
        subscription: "free",
        packageLimit: 5,
        createdAt: new Date(),
      };
      const result = await usersCollection.insertOne(hrDoc);
      res.send(result);
    });

    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyHR,
      async (req, res) => {
        const id = req.params.id;
        const { role } = req.body;
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } }
        );
        res.send(result);
      }
    );

    // -------------------- Root --------------------
    app.get("/", (req, res) => {
      res.send("AssetVerse Server Running");
    });

    await db.command({ ping: 1 });
    console.log("✅ MongoDB connected");
  } finally {
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(✅ Server running on port ${port});
});

