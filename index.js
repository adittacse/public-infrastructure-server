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

// 🔹 Firebase Admin helper: delete user by email
const deleteFirebaseUserByEmail = async (email) => {
    try {
        const userRecord = await admin.auth().getUserByEmail(email);
        await admin.auth().deleteUser(userRecord.uid);
        return { success: true };
    } catch (error) {
        if (error.code === "auth/user-not-found") {
            // absent in firebase, but may stay in database
            return { success: false, reason: "not-found" };
        }
        throw error;
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

        // role based middleware
        const verifyAdmin = async (req, res, next) => {
            const email = req.token_email;
            const query = { email: email };
            const user = await usersCollection.findOne(query);

            if (!user || user.role !== "admin") {
                return res.status(403).send({ message: "Forbidden Access" });
            }
            req.currentUser = user;
            next();
        };

        const verifyStaff = async (req, res, next) => {
            const email = req.token_email;
            const query = { email: email };
            const user = await usersCollection.findOne(query);

            if (!user || user.role !== "staff") {
                return res.status(403).send({ message: "Forbidden Access" });
            }
            req.currentUser = user;
            next();
        };

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
                issueId,
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
            const timelineQuery = { issueId: id };
            
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

            issue.reporterEmail = user.email;
            issue.reporterName = user.displayName;
            issue.reporterId = user._id.toHexString();
            issue.status = "pending";
            issue.priority = "normal";
            issue.isBoosted = false;
            issue.upvotes = [];
            issue.upvoteCount = 0;
            issue.assignedStaffId = "";
            issue.assignedStaffName = "";
            issue.assignedStaffEmail = "";
            issue.createdAt = new Date();
            issue.updatedAt = new Date();

            const result = await issuesCollection.insertOne(issue);

            await logTimeline({
                issueId: result.insertedId.toHexString(),
                status: "pending",
                message: "Issue reported by citizen",
                updatedByName: user.displayName,
                updatedByRole: "citizen",
                updatedByEmail: email
            });

            res.send(result);
        });

        // citizen related api's
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

        app.get("/citizen/my-issue-locations", verifyFirebaseToken, async (req, res) => {
            const email = req.token_email;

            const pipeline = [
                { 
                    $match: { 
                        reporterEmail: email 
                    } 
                },
                {
                    $group: {
                        _id: "$location",
                    }
                },
                {
                    $project: {
                        _id: 0,
                        location: "$_id",
                    }
                },
                {
                    $sort: {
                        location: 1
                    }
                }
            ];

            const cursor = issuesCollection.aggregate(pipeline);
            const locations = await cursor.toArray();
            
            const result = locations.map(item => item.location).filter(Boolean);
            res.send(result);
        });

        app.get("/citizen/my-issues", verifyFirebaseToken, verifyNotBlocked, async (req, res) => {
            const email = req.token_email;
            const { status, location } = req.query;
            const query = { reporterEmail: email };

            if (status) {
                query.status = status;
            }
            if (location) {
                query.location = location;
            }

            const options = {
                sort: { createdAt: -1 }
            };

            const cursor = issuesCollection.find(query, options);
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

        app.delete("/citizen/issues/:id", verifyFirebaseToken, verifyNotBlocked, async (req, res) => {
            const id = req.params.id;
            const email = req.token_email;
            const query = { _id: new ObjectId(id) };

            const issue = await issuesCollection.findOne(query);

            if (issue.reporterEmail !== email) {
                return res.status(403).send({ message: "Forbidden Access" });
            }

            const timelineQuery = { issueId: id };
            const timelineResult = await timelinesCollection.deleteMany(timelineQuery);

            const result = await issuesCollection.deleteOne(query);
            res.send(result);
        });

        // admin related api's
        app.get("/admin/overview", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            // issue stats
            const totalIssues = await issuesCollection.countDocuments({});

            const statusPipeline = [
                {
                    $group: {
                        _id: "$status",
                        count: { 
                            $sum: 1 
                        }
                    }
                }
            ];
            const statusResult = await issuesCollection.aggregate(statusPipeline).toArray();

            const stats = {
                totalIssues,
                pending: 0,
                inProgress: 0,
                working: 0,
                resolved: 0,
                closed: 0,
                rejected: 0,
            };

            statusResult.forEach((item) => {
                const status = item._id;
                if (status === "pending") {
                    stats.pending = item.count;
                }
                if (status === "in_progress") {
                    stats.inProgress = item.count;
                }
                if (status === "working") {
                    stats.working = item.count;
                }
                if (status === "resolved") {
                    stats.resolved = item.count;
                }
                if (status === "closed") {
                    stats.closed = item.count;
                }
                if (status === "rejected") {
                    stats.rejected = item.count;
                }
            });

            // payment stats
            const paymentPipeline = [
                {
                    $group: {
                        _id: null,
                        totalAmount: { $sum: "$amount" },
                        totalCount: { $sum: 1 },
                    }
                }
            ];
            const paymentCursor = paymentsCollection.aggregate(paymentPipeline);
            const paymentAgg = await paymentCursor.toArray();

            stats.totalPayments = paymentAgg[0]?.totalAmount || 0;
            stats.totalPaymentCount = paymentAgg[0]?.totalCount || 0;

            // latest issues (first boosted, then date)
            const latestIssuesCursor = issuesCollection
                .find({})
                .sort({ priority: -1, createdAt: -1 })
                .limit(5)
                .project({
                    title: 1,
                    category: 1,
                    status: 1,
                    priority: 1
                });

            const latestIssues = await latestIssuesCursor.toArray();

            // latest payments
            const latestPaymentsCursor = paymentsCollection.find({}).sort({ paidAt: -1 }).limit(5);
            const latestPayments = await latestPaymentsCursor.toArray();

            // latest users (citizens)
            const latestUsersCursor = usersCollection
                .find({ role: "citizen" })
                .sort({ createdAt: -1 })
                .limit(5)
                .project({
                    displayName: 1,
                    email: 1,
                    photoURL: 1,
                    isPremium: 1,
                    isBlocked: 1,
                    role: 1,
                });

            const latestUsers = await latestUsersCursor.toArray();

            return res.send({
                stats,
                latestIssues,
                latestPayments,
                latestUsers,
            });
        });

        app.get("/admin/issues", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const { status, priority, category } = req.query;
            const query = {};

            if (status) {
                query.status = status;
            }
            if (priority) {
                query.priority = priority;
            }
            if (category) {
                query.category = category;
            }

            const options = { priority: -1, createdAt: -1 };
            const cursor = issuesCollection.find(query, options);
            const result = await cursor.toArray();
            res.send(result);
        });

        app.get("/admin/users", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const { searchText } = req.params;
            const query = {};
            // const query = {
            //     $or: [
            //         { role: { $exists: false } },
            //         { role: "citizen" },
            //         { role: "staff" }
            //     ]
            // };

            if (searchText) {
                query.$and = [
                    {
                        $or: [
                            { displayName: { $regex: searchText, $options: "i" } },
                            { email: { $regex: searchText, $options: "i" } }
                        ]
                    }
                ];
            }

            const options = { createdAt: -1 };
            const cursor = usersCollection.find(query, options);
            const result = await cursor.toArray();
            res.send(result);
        });

        app.get("/admin/staff", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const query = { role: "staff" };
            const options = { createdAt: -1 };
            const cursor = usersCollection.find(query, options);
            const result = await cursor.toArray();
            res.send(result);
        });
        
        app.get("/admin/profile", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const tokenEmail = req.token_email;
            const email = req.query.email;
            
            if (email !== tokenEmail) {
                return res.status(403).send({ message: "Forbidden Access" });
            }

            const query = { email: email };
            const user = await usersCollection.findOne(query);
            res.send(user);
        });

        app.patch("/admin/profile/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const userUpdatedData = req.body;
            const query = { _id: new ObjectId(id) };
            const update = {
                $set: {
                    displayName: userUpdatedData.displayName,
                }
            };

            if (userUpdatedData.photoURL) {
                update.$set.photoURL = userUpdatedData.photoURL;
            }

            const options = {};
            const result = await usersCollection.updateOne(query, update, options);
            res.send(result);
        });
        
        app.patch("/admin/users/:id/role", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const { role } = req.body;

            if (!role) {
                return res.status(400).send({ message: "Role is required" });
            }
            
            const update = {
                $set: {
                    role: role,
                }
            };
            const options = {};
            const result = await usersCollection.updateOne(query, update, options);
            res.send(result);
        });

        app.patch("/admin/citizens/:id/block", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const { isBlocked } = req.body;
            const query = { _id: new ObjectId(id) };
            const update = {
                $set: {
                    isBlocked: !!isBlocked,
                },
            };
            const result = await usersCollection.updateOne(query, update);
            res.send(result);
        });

        app.patch("/admin/issues/:id/assign-staff", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const { staffId } = req.body;
            const issueQuery = { _id: new ObjectId(id) };
            const issue = await issuesCollection.findOne(issueQuery);
            
            // don't assign staff if already assigned
            if (issue.assignedStaffId) {
                return res.status(400).send({ message: "Staff already assigned for this issue" });
            }

            // get search staff user
            const staffQuery = { _id: new ObjectId(staffId) };
            const staff = await usersCollection.findOne(staffQuery);

            const adminName = req.currentUser?.displayName;
            const adminEmail = req.token_email;

            const updateDoc = {
                $set: {
                    assignedStaffId: staffId,
                    assignedStaffName: staff.displayName,
                    assignedStaffEmail: staff.email,
                    assignedStaffPhoto: staff.photoURL,
                    updatedAt: new Date(),
                    // status is always pending as per requirement
                },
            };

            const result = await issuesCollection.updateOne(issueQuery, updateDoc);

            // timeline log create
            await logTimeline({
                issueId: id,
                status: issue.status,
                message: `Issue assigned to staff: ${staff.displayName}`,
                updatedByName: adminName,
                updatedByRole: "admin",
                updatedByEmail: adminEmail,
            });

            return res.send({
                success: result.modifiedCount > 0,
                modifiedCount: result.modifiedCount,
                matchedCount: result.matchedCount,
            });
        }
    );

        app.delete("/admin/users/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
                const id = req.params.id;
                const query = { _id: new ObjectId(id) };
                const user = await usersCollection.findOne(query);
                
                if (req.token_email === user.email) {
                    return res.status(400).send({ message: "You can't delete yourself" });
                }
                
                if (user.email) {
                    await deleteFirebaseUserByEmail(user.email);
                    await timelinesCollection.deleteMany({ updatedByEmail: user.email });
                    await issuesCollection.deleteMany({ reporterEmail: user.email });
                }
                
                const result = await usersCollection.deleteOne(query);
                return res.send(result);
            },
        );

        // staff related api's
        app.get("/staff/overview", verifyFirebaseToken, verifyStaff, async (req, res) => {
            const email = req.token_email;

            const baseQuery = {
                assignedStaffEmail: email
            };

            // মোট assigned issue
            const assignedCount = await issuesCollection.countDocuments(baseQuery);

            // status অনুযায়ী count
            const statuses = ["pending", "in_progress", "working", "resolved", "closed"];
            const countsByStatus = await issuesCollection.aggregate([
                { $match: baseQuery },
                {
                    $group: {
                        _id: "$status",
                        count: { $sum: 1 }
                    }
                }
            ]).toArray();

            const countMap = {};
            statuses.forEach((st) => {
                countMap[st] = 0;
            });
            countsByStatus.forEach((item) => {
                countMap[item._id] = item.count;
            });

            // boosted issues (যেগুলোতে isBoosted true)
            const boostedIssuesCount = await issuesCollection.countDocuments({
                assignedStaffEmail: email,
                isBoosted: true
            });

            // todayTasksCount — সহজভাবে ধরলাম pending / in_progress / working
            const todayTasksCount = await issuesCollection.countDocuments({
                assignedStaffEmail: email,
                status: { $in: ["pending", "in_progress", "working"] }
            });

            const totalIssues = assignedCount;

            res.send({
                assignedCount,
                inProgressCount: countMap["in_progress"] || 0,
                workingCount: countMap["working"] || 0,
                resolvedCount: countMap["resolved"] || 0,
                closedCount: countMap["closed"] || 0,
                todayTasksCount,
                boostedIssuesCount,
                totalIssues
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