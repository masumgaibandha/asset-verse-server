const express = require('express')
const cors = require('cors')
const app = express();
require('dotenv').config()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000
// const crypto = require("crypto")

const admin = require("firebase-admin");

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_ADMIN_B64, "base64").toString("utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});


// Middleware
app.use(express.json());
app.use(cors())

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' })
  }

  try {
    const idToken = token.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(idToken)
    console.log('decoded in the token', decoded)
    req.decoded_email = decoded.email;
    next();
  }
  catch (err) {
    return res.status(401).send({ message: 'unauthorized access' })
  }


}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.xhu33ja.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    await client.connect();

    const db = client.db('asset-verse');
    const requestsCollection = db.collection('requests');
    const packagesCollection = db.collection('packages');
    const usersCollection = db.collection('users');
    const paymentsCollection = db.collection('payments');

    //  Requests API
    app.get('/requests', async (req, res) => {
      const query = {}
      const { email } = req.query;
      if (email) {
        query.employeeEmail = email;
      }
      const options = { sort: { createdAt: -1 } }

      const cursor = requestsCollection.find(query, options);
      const result = await cursor.toArray()
      res.send(result);
    })

    app.post('/requests', async (req, res) => {
      const request = req.body;

      request.requestStatus = 'pending';
      request.createdAt = new Date();
      request.approvalDate = null;

      const result = await requestsCollection.insertOne(request);
      res.send(result);
    })

    app.delete('/requests/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await requestsCollection.deleteOne(query)
      res.send(result);
    })

    //  Packages API
    app.get('/packages', async (req, res) => {
      const cursor = packagesCollection.find({}).sort({ employeeLimit: 1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    //  Payments API (NEW)
    app.get('/payments', verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      // console.log('Header look', req.headers)

      if (email) {
        query.hrEmail = email;
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: 'forbidden access' })
        }

      }

      const result = await paymentsCollection
        .find(query)
        .sort({ paymentDate: -1 })
        .toArray();

      res.send(result);
    });

    //  Stripe Checkout Session
    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.price) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: amount,
              product_data: {
                name: `AssetVerse Package: ${paymentInfo.packageName}`,
              },
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
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

    //  Upgrade Success
    app.patch('/upgrade-success', async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status !== 'paid') {
        return res.send({ success: false, message: 'Payment not completed' });
      }

      const hrEmail = session.customer_email;
      const packageName = session.metadata.packageName;
      const employeeLimit = Number(session.metadata.employeeLimit);

      //  prevent duplicate insert
      const transactionId = session.payment_intent;
      const paymentExists = await paymentsCollection.findOne({ transactionId });

      if (paymentExists) {
        return res.send({
          success: true,
          message: "Payment already recorded",
          transactionId,
        });
      }

      //  Update HR user package info
      const userQuery = { email: hrEmail, role: 'hr' };
      const userUpdate = {
        $set: {
          subscription: packageName.toLowerCase(),
          packageLimit: employeeLimit,
          updatedAt: new Date(),
        },
      };
      const updateResult = await usersCollection.updateOne(userQuery, userUpdate);

      //  Save payment history
      const paymentDoc = {
        hrEmail,
        packageName,
        employeeLimit,
        amount: session.amount_total / 100,
        transactionId,
        paymentDate: new Date(),
        status: 'completed',
      };
      const paymentResult = await paymentsCollection.insertOne(paymentDoc);

      return res.send({
        success: true,
        transactionId,
        updateResult,
        paymentResult,
      });
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Asset Verse Server Running')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
