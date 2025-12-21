const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 3000;

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_ADMIN_B64, "base64").toString("utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

app.use(express.json());
app.use(cors());

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

    const assetsCollection = db.collection("assets");
    const assignedAssetsCollection = db.collection("assignedAssets");
    const employeeAffiliationsCollection = db.collection("employeeAffiliations");

    const verifyHR = async (req, res, next) => {
      const email = req.decoded_email;
      const user = await usersCollection.findOne({ email });
      if (!user || user.role !== "hr") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    app.get("/affiliations/me", verifyFBToken, async (req, res) => {
      const employeeEmail = req.decoded_email;

      const result = await employeeAffiliationsCollection
        .find({ employeeEmail, status: "active" })
        .sort({ affiliationDate: -1 })
        .toArray();

      res.send(result);
    });

    app.get("/team", verifyFBToken, async (req, res) => {
      const employeeEmail = req.decoded_email;
      const { hrEmail } = req.query;

      if (!hrEmail) return res.status(400).send({ message: "hrEmail required" });

      const affiliated = await employeeAffiliationsCollection.findOne({
        employeeEmail,
        hrEmail,
        status: "active",
      });

      if (!affiliated) return res.status(403).send({ message: "forbidden access" });

      const team = await employeeAffiliationsCollection
        .find({ hrEmail, status: "active" })
        .sort({ affiliationDate: -1 })
        .toArray();

      res.send(team);
    });

    app.get("/assigned-assets", verifyFBToken, async (req, res) => {
      const email = req.query.email;

      if (!email) return res.status(400).send({ message: "email required" });
      if (email !== req.decoded_email) {
        return res.status(403).send({ message: "forbidden access" });
      }

      const result = await assignedAssetsCollection
        .find({ employeeEmail: email })
        .sort({ assignmentDate: -1 })
        .toArray();

      res.send(result);
    });

    app.patch("/assigned-assets/:id/return", verifyFBToken, async (req, res) => {
      const id = req.params.id;

      const item = await assignedAssetsCollection.findOne({ _id: new ObjectId(id) });
      if (!item) return res.status(404).send({ message: "Not found" });

      if (item.employeeEmail !== req.decoded_email) {
        return res.status(403).send({ message: "forbidden access" });
      }

      if (item.status !== "assigned") {
        return res.status(400).send({ message: "Already returned" });
      }

      if (item.assetType !== "Returnable") {
        return res.status(400).send({ message: "not returnable" });
      }

      const qty = Number(item.assetQTY || 1);

      const assignedResult = await assignedAssetsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "returned", returnDate: new Date() } }
      );

      await assetsCollection.updateOne(
        { _id: new ObjectId(item.assetId) },
        { $inc: { availableQuantity: qty } }
      );

      if (item.requestId) {
        await requestsCollection.updateOne(
          { _id: new ObjectId(item.requestId) },
          { $set: { requestStatus: "returned" } }
        );
      }

      res.send({ assignedResult });
    });

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
      const { displayName, photoURL, companyLogo, companyName, dateOfBirth } = req.body;

      const updateDoc = {
        ...(displayName !== undefined && { displayName }),
        ...(photoURL !== undefined && { photoURL }),
        ...(dateOfBirth !== undefined && { dateOfBirth }),
      };

      // HR-only fields (optional enhancement)
      const me = await usersCollection.findOne({ email });
      if (me?.role === "hr") {
        if (companyLogo !== undefined) updateDoc.companyLogo = companyLogo;
        if (companyName !== undefined) updateDoc.companyName = companyName;
      }

      const result = await usersCollection.updateOne(
        { email },
        { $set: updateDoc, $currentDate: { updatedAt: true } }
      );

      res.send(result);
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

      const email = user.email;
      const userExists = await usersCollection.findOne({ email });
      if (userExists) return res.send({ message: "user exists" });

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.post("/users/hr", async (req, res) => {
      const user = req.body;

      const email = user.email;
      const userExists = await usersCollection.findOne({ email });
      if (userExists) return res.send({ message: "user exists" });

      const hrDoc = {
        email,
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

    app.patch("/users/:id/role", verifyFBToken, verifyHR, async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } }
      );

      res.send(result);
    });

    app.get("/employees", async (req, res) => {
      const query = {};
      const { status, workStatus } = req.query;

      if (status) query.status = status;
      if (workStatus) query.workStatus = workStatus;

      const result = await employeesCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    });

    app.post("/employees", async (req, res) => {
      try {
        const employee = req.body;

        employee.status = "pending";
        employee.workStatus = "inactive";
        employee.createdAt = new Date();

        const result = await employeesCollection.insertOne(employee);
        res.send(result);
      } catch (err) {
        res.status(400).send({ message: err.message });
      }
    });

    app.patch("/employees/:id", verifyFBToken, verifyHR, async (req, res) => {
      const { status, email } = req.body;
      const id = req.params.id;

      const update = {
        $set: {
          status,
          approvedAt: new Date(),
          workStatus: status === "approved" ? "available" : "inactive",
        },
      };

      if (status === "approved") update.$set.workStatus = "available";
      if (status === "rejected") update.$set.workStatus = "inactive";

      const result = await employeesCollection.updateOne({ _id: new ObjectId(id) }, update);

      if (status === "approved" && email) {
        await usersCollection.updateOne({ email }, { $set: { role: "employee" } });
      }

      res.send(result);
    });

    app.delete("/employees/:id", async (req, res) => {
      const id = req.params.id;
      const result = await employeesCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    app.get("/hr/employees", verifyFBToken, verifyHR, async (req, res) => {
      const hrEmail = req.decoded_email;

      const result = await employeeAffiliationsCollection
        .find({ hrEmail, status: "active" })
        .sort({ affiliationDate: -1 })
        .toArray();

      res.send(result);
    });


    app.post("/assets", verifyFBToken, verifyHR, async (req, res) => {
      const hrEmail = req.decoded_email;
      const asset = req.body;

      const doc = {
        productName: asset.productName,
        productImage: asset.productImage,
        productType: asset.productType,
        productQuantity: Number(asset.productQuantity || 0),
        availableQuantity: Number(asset.productQuantity || 0),
        hrEmail,
        companyName: asset.companyName || "",
        dateAdded: new Date(),
      };

      const result = await assetsCollection.insertOne(doc);
      res.send(result);
    });

    app.get("/assets", verifyFBToken, verifyHR, async (req, res) => {
      const hrEmail = req.decoded_email;
      const { type, search } = req.query;

      const page = Number(req.query.page || 1);
      const limit = Number(req.query.limit || 10);
      const skip = (page - 1) * limit;

      const query = { hrEmail };
      if (type) query.productType = type;
      if (search) query.productName = { $regex: search, $options: "i" };

      const total = await assetsCollection.countDocuments(query);

      const result = await assetsCollection
        .find(query)
        .sort({ dateAdded: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      res.send({
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        result,
      });
    });

    app.patch("/assets/:id", verifyFBToken, verifyHR, async (req, res) => {
      const id = req.params.id;
      const update = req.body;

      const result = await assetsCollection.updateOne(
        { _id: new ObjectId(id), hrEmail: req.decoded_email },
        {
          $set: {
            productName: update.productName,
            productImage: update.productImage,
            productType: update.productType,
            productQuantity: Number(update.productQuantity),
          },
        }
      );

      res.send(result);
    });

    app.delete("/assets/:id", verifyFBToken, verifyHR, async (req, res) => {
      const id = req.params.id;
      const result = await assetsCollection.deleteOne({
        _id: new ObjectId(id),
        hrEmail: req.decoded_email,
      });
      res.send(result);
    });

    app.get("/assets/available", verifyFBToken, async (req, res) => {
      const result = await assetsCollection
        .find({ availableQuantity: { $gt: 0 } })
        .sort({ dateAdded: -1 })
        .toArray();
      res.send(result);
    });

    app.get("/hr/stats/asset-types", verifyFBToken, verifyHR, async (req, res) => {
      const hrEmail = req.decoded_email;

      const data = await assetsCollection
        .aggregate([
          { $match: { hrEmail } },
          { $group: { _id: "$productType", value: { $sum: 1 } } },
          { $project: { _id: 0, name: "$_id", value: 1 } },
        ])
        .toArray();

      res.send(data);
    });

    app.get("/hr/stats/top-requested", verifyFBToken, verifyHR, async (req, res) => {
      const hrEmail = req.decoded_email;

      const data = await requestsCollection
        .aggregate([
          { $match: { hrEmail } },
          { $group: { _id: "$assetName", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 5 },
          { $project: { _id: 0, name: "$_id", count: 1 } },
        ])
        .toArray();

      res.send(data);
    });

    app.get("/requests", async (req, res) => {
      const query = {};
      const { email, requestStatus } = req.query;

      if (email) query.employeeEmail = email;
      if (requestStatus) query.requestStatus = requestStatus;

      const result = await requestsCollection.find(query).sort({ createdAt: -1 }).toArray();
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

    app.patch("/requests/:id/assign", verifyFBToken, verifyHR, async (req, res) => {
      const { employeeId, employeeName, employeeEmail } = req.body;
      const id = req.params.id;
      const hrEmail = req.decoded_email;

      const hr = await usersCollection.findOne({ email: hrEmail, role: "hr" });
      if (!hr) return res.status(403).send({ message: "forbidden access" });

      const credit = Number(hr.packageLimit ?? 0);
      if (credit <= 0) {
        return res.status(403).send({ message: "No credit left" });
      }

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

      const employeeResult = await employeesCollection.updateOne(
        { _id: new ObjectId(employeeId) },
        { $set: { workStatus: "busy" } }
      );

      const creditResult = await usersCollection.updateOne(
        { email: hrEmail, role: "hr", packageLimit: { $gt: 0 } },
        { $inc: { packageLimit: -1 } }
      );

      res.send({ requestResult, employeeResult, creditResult });
    });

    app.patch("/requests/:id/status", verifyFBToken, verifyHR, async (req, res) => {
      const { requestStatus } = req.body;
      const id = req.params.id;

      const request = await requestsCollection.findOne({ _id: new ObjectId(id) });

      const result = await requestsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { requestStatus, approvalDate: new Date() } }
      );

      if (
        ["returned", "completed", "rejected"].includes(requestStatus) &&
        request?.assignedEmployeeId
      ) {
        await employeesCollection.updateOne(
          { _id: new ObjectId(request.assignedEmployeeId) },
          { $set: { workStatus: "available" } }
        );
      }

      res.send(result);
    });

    app.get("/requests/hr", verifyFBToken, verifyHR, async (req, res) => {
      const hrEmail = req.decoded_email;
      const result = await requestsCollection.find({ hrEmail }).sort({ createdAt: -1 }).toArray();
      res.send(result);
    });

    app.patch("/requests/:id/decision", verifyFBToken, verifyHR, async (req, res) => {
      const id = req.params.id;
      const { decision } = req.body;

      if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).send({ message: "Invalid decision" });
      }

      const hrEmail = req.decoded_email;

      const request = await requestsCollection.findOne({ _id: new ObjectId(id) });
      if (!request) return res.status(404).send({ message: "Request not found" });

      if (request.hrEmail !== hrEmail) {
        return res.status(403).send({ message: "forbidden access" });
      }

      if (request.requestStatus !== "pending") {
        return res.status(400).send({ message: "Already processed" });
      }

      if (decision === "rejected") {
        const result = await requestsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              requestStatus: "rejected",
              approvalDate: new Date(),
              processedBy: hrEmail,
            },
          }
        );
        return res.send({ ok: true, result });
      }

      const hrUser = await usersCollection.findOne({ email: hrEmail, role: "hr" });
      if (!hrUser || (hrUser.packageLimit ?? 0) <= 0) {
        return res.status(403).send({ message: "No credit left" });
      }

      const assetId = request.assetId;
      const qty = Number(request.assetQTY || 1);

      const asset = await assetsCollection.findOne({ _id: new ObjectId(assetId) });
      if (!asset) return res.status(404).send({ message: "Asset not found" });

      if ((asset.availableQuantity ?? 0) < qty) {
        return res.status(400).send({ message: "Not enough stock" });
      }

      const requestResult = await requestsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            requestStatus: "approved",
            approvalDate: new Date(),
            processedBy: hrEmail,
          },
        }
      );

      const assetResult = await assetsCollection.updateOne(
        { _id: new ObjectId(assetId) },
        { $inc: { availableQuantity: -qty } }
      );

      const assignedResult = await assignedAssetsCollection.insertOne({
        assetId: new ObjectId(request.assetId),
        assetName: request.assetName,
        assetImage: request.assetImage || "",
        assetType: request.assetType,
        assetQTY: Number(request.assetQTY || 1),

        employeeEmail: request.employeeEmail,
        employeeName: request.employeeName,

        hrEmail,
        companyName: request.companyName,
        companyLogo: request.companyLogo || "",

        requestDate: request.createdAt,
        approvalDate: new Date(),
        assignmentDate: new Date(),

        returnDate: null,
        status: "assigned",
        requestId: new ObjectId(id),
      });

      await employeeAffiliationsCollection.updateOne(
        { employeeEmail: request.employeeEmail, hrEmail },
        {
          $setOnInsert: {
            employeeEmail: request.employeeEmail,
            employeeName: request.employeeName,
            hrEmail,
            companyName: request.companyName,
            companyLogo: request.companyLogo || "",
            affiliationDate: new Date(),
            status: "active",
          },
        },
        { upsert: true }
      );

      const creditResult = await usersCollection.updateOne(
        { email: hrEmail, role: "hr", packageLimit: { $gt: 0 } },
        { $inc: { packageLimit: -1 } }
      );

      res.send({ ok: true, requestResult, assetResult, assignedResult, creditResult });
    });

    app.post("/requests/employee", verifyFBToken, async (req, res) => {
      const data = req.body;

      if (data.requesterEmail !== req.decoded_email) {
        return res.status(403).send({ message: "forbidden access" });
      }

      const requestDoc = {
        assetId: new ObjectId(data.assetId),
        assetName: data.assetName,
        assetImage: data.assetImage || "",
        assetType: data.assetType,
        assetQTY: Number(data.assetQTY || 1),

        employeeName: data.requesterName,
        employeeEmail: data.requesterEmail,

        hrEmail: data.hrEmail,
        companyName: data.companyName,
        companyLogo: data.companyLogo || "",

        requestStatus: "pending",
        note: data.note || "",
        createdAt: new Date(),
        approvalDate: null,
        processedBy: null,
      };

      const result = await requestsCollection.insertOne(requestDoc);
      res.send(result);
    });

    app.get("/packages", async (req, res) => {
      const result = await packagesCollection.find({}).sort({ employeeLimit: 1 }).toArray();
      res.send(result);
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      if (email) {
        query.hrEmail = email;
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }

      const result = await paymentsCollection.find(query).sort({ paymentDate: -1 }).toArray();
      res.send(result);
    });

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

      const paymentExists = await paymentsCollection.findOne({ transactionId });
      if (paymentExists) {
        return res.send({ success: true, message: "Payment already recorded", transactionId });
      }

      const updateResult = await usersCollection.updateOne(
        { email: hrEmail, role: "hr" },
        {
          $set: {
            subscription: packageName.toLowerCase(),
            updatedAt: new Date(),
          },
          $inc: {
            packageLimit: employeeLimit,
          },
        }
      );

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

    await client.db("admin").command({ ping: 1 });
  } finally {
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Asset Verse Server Running");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
