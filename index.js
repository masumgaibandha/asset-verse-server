const express = require('express')
const cors = require('cors')
const app = express();
require('dotenv').config()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000

app.use(express.json());
app.use(cors())

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.xhu33ja.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db('asset-verse');
    const requestsCollection = db.collection('requests');
    const packagesCollection = db.collection('packages');


    // Assets api
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

    app.get('/packages', async (req, res) => {

      const cursor = packagesCollection.find({}).sort({ employeeLimit: 1 });
      const result = await cursor.toArray();
      res.send(result);

    });




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
        success_url: `${process.env.SITE_DOMAIN}/dashboard/upgrade-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/upgrade-package`,
        metadata: {
         packageId: paymentInfo.packageId,
         employeeLimit: paymentInfo.employeeLimit,
        },
      });
      console.log(session)
      res.send({ url: session.url });
    });





    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
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
