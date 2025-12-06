const express = require("express");
const app = express();
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
const admin = require("firebase-admin");
const serviceAccount = require("./public-infrastructure-firebase-adminsdk.json");
const dotenv = require("dotenv");
dotenv.config();
const port = process.env.PORT || 3000;

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// middleware
app.use(cors());
app.use(express.json());

// firebase token verify middleware
const verifyFirebaseToken = async (req, res, next) => {
    const authorization = req.headers.authorization;
    if (!authorization) {
        return res.status(401).send({ message: "Unauthorized Access" });
    }

    const token = authorization.split(" ")[1];
    if (!token) {
        return res.status(401).send({ message: "Unauthorized Access" });
    }

    try {
        const userInfo = await admin.auth().verifyIdToken(token);
        req.token_email = userInfo.email;
        next();
    } catch {
        return res.status(401).send({ message: "Unauthorized Access" });
    }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.gkaujxr.mongodb.net/?appName=Cluster0`;

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
        const db = client.db("publicInfrastructureDB");

        const usersCollection = db.collection("users");
        const issuesCollection = db.collection("issues");

        // user's related api's
        app.get("/users/:email/role", async (req, res) => {
            const email = req.params.email;
            const query = {};
            if (email) {
                query.email = email;
            }
            const user = await usersCollection.findOne(query);
            res.send({
                role: user?.role || "citizen",
                isPremium: !!user?.isPremium,
                isBlocked: !!user?.isBlocked
            });
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

app.get("/", (req, res) => {
    res.send("Public Infrastructure Issue Reporting server is running!");
});

app.listen(port, () => {
    console.log(`Public Infrastructure Issue Reporting Server listening on ${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}`);
});