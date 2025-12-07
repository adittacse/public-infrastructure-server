const express = require("express");
const app = express();
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
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
        const paymentsCollection = db.collection("payments");
        const timelinesCollection = db.collection("timelines");

        // more middleware
        const verifyNotBlocked = async (req, res, next) => {
            const email = req.token_email;
            const query = { email: email };
            const user = await usersCollection.findOne(query);
            if (user && user.isBlocked) {
                return res.status(403).send({ message: "You are blocked by admin" });
            }
            req.currentUser = user;
            next();
        }

        // helper
        const logTimeline = async (data) => {
            const { issueId, status, message, updatedByName, updatedByRole, updatedByEmail } = data;
            const log = {
                issueId: new ObjectId(issueId),
                status,
                message,
                updatedByName,
                updatedByRole,
                updatedByEmail,
                createdAt: new Date()
            };
            const result = await timelinesCollection.insertOne(log);
            return result;
        }

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

        app.post("/users", async (req, res) => {
            const user = req.body;
            const email = user.email;
            const query = {};
            if (email) {
                query.email = email;
            }

            const userExists = await usersCollection.findOne(query);
            if (userExists) {
                return res.send({ message: "user exists" });
            }

            user.role = user.role || "citizen";
            user.isPremium = false;
            user.isBlocked = false;
            user.createdAt = new Date();

            const result = await usersCollection.insertOne(user);
            return res.send(result);
        });

        // issues related api's
        app.get("/issues/latest-resolved", async (req, res) => {
            const query = {
                status: {
                    $in: ["resolved", "closed"]
                }
            };
            const cursor = issuesCollection.find(query).sort({ updatedAt: -1 }).limit(6);
            const result = await cursor.toArray();
            res.send(result);
        });

        app.get("/issues/:id", async (req, res) => {
            const id = req.params.id;
            const issueIdQuery = { _id: new ObjectId(id) };
            const timelineQuery = { issueId: new ObjectId(id) };
            
            const issue = await issuesCollection.findOne(issueIdQuery);
            if (!issue) {
                return res.status(404).send({ message: "Issue not found" });
            }
            
            const cursor = timelinesCollection.find(timelineQuery).sort({ createdAt: -1 });
            const timelines = await cursor.toArray();
            
            return res.send({ issue, timelines });
        });

        app.post("/issues", verifyFirebaseToken, verifyNotBlocked, async (req, res) => {
            const issue = req.body;
            const email = req.token_email;
            const query = {};
            if (email) {
                query.reporterEmail = email;
            }

            const user = await usersCollection.findOne({ email });
            if (!user) {
                return res.status(400).send({ message: "User not found" });
            }
            
            // free user limit
            if (!user.isPremium) {
                const count = await issuesCollection.countDocuments(query);
                if (count >= 3) {
                    return res.status(403).send({
                        message: "Free user issue limit exceeded",
                        needSubscription: true,
                    });
                }
            }

            issue.reporterEmail = email;
            issue.reporterName = user.displayName;
            issue.reporterId = user._id;
            issue.status = "pending";
            issue.priority = "normal";
            issue.isBoosted = false;
            issue.upvotes = [];
            issue.upvoteCount = 0;
            issue.assignedStaffId = null;
            issue.assignedStaffName = "";
            issue.assignedStaffEmail = "";
            issue.createdAt = new Date();
            issue.updatedAt = new Date();

            const result = await issuesCollection.insertOne(issue);

            await logTimeline({
                issueId: result.insertedId,
                status: "pending",
                message: "Issue reported by citizen",
                updatedByName: user.displayName,
                updatedByRole: "citizen",
                updatedByEmail: email
            });

            res.send(result);
        });

        // citizen api's
        app.get("/citizen/stats", verifyFirebaseToken, verifyNotBlocked, async (req, res) => {
            const email = req.token_email;
            const query = {};
            if (email) {
                query.customerEmail = email;
            }

            const pipeline = [
                {
                    $match: {
                        reporterEmail: email
                    }
                },
                {
                    $group: {
                        _id: "$status",
                        count: {
                            $sum: 1
                        }
                    }
                }
            ];

            const cursor = issuesCollection.aggregate(pipeline);
            const statusStats = await cursor.toArray();

            const paymentCursor = paymentsCollection.find(query).sort({ paidAT: -1 });
            const payments = await paymentCursor.toArray();
            res.send({
                statusStats,
                totalPayments: paymentCursor.length,
                payments
            });
        });

        app.get("/citizen/my-issues", verifyFirebaseToken, verifyNotBlocked, async (req, res) => {
            const email = req.token_email;
            const { status, category } = req.query;
            const query = { reporterEmail: email };

            if (status) {
                query.status = status;
            }
            if (category) {
                query.category = category;
            }

            const cursor = issuesCollection.find(query).sort({ createdAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        });

        app.patch("/citizen/issues/:id", verifyFirebaseToken, verifyNotBlocked, async (req, res)=> {
            const id = req.params.id;
            const displayName = req.currentUser.displayName;
            const email = req.token_email;
            const updatedIssue = req.body;
            const query = { _id: new ObjectId(id) };
            
            const issue = await issuesCollection.findOne(query);
            
            if (!issue) {
                return res.status(404).send({ message: "Issue not found" });
            }
            if (issue.reporterEmail !== email) {
                return res.status(403).send({ message: "Forbidden Access" });
            }
            if (issue.status !== "pending") {
                return res.status(400).send({ message: "Only pending issues can be edited" });
            }
            
            const update = {
                $set: {
                    title: updatedIssue.title,
                    description: updatedIssue.description,
                    category: updatedIssue.category,
                    location: updatedIssue.location,
                    updatedAt: new Date()
                }
            };

            // if image link found (optional in frontend)
            if (updatedIssue.image) {
                update.$set.image = updatedIssue.image;
            }

            const result = await issuesCollection.updateOne(query, update);

            await logTimeline({
                issueId: id,
                status: issue.status,
                message: "Issue updated by citizen",
                updatedByName: displayName,
                updatedByRole: "citizen",
                updatedByEmail: email,
            });

            res.send(result);
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