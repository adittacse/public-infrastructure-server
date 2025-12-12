const express = require("express");
const app = express();
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const serviceAccount = require("./public-infrastructure-firebase-adminsdk.json");
const PDFDocument = require("pdfkit");
const dotenv = require("dotenv");
dotenv.config();
const port = process.env.PORT || 3000;
const stripe = require("stripe")(process.env.STRIPE_SECRET);

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
        const categoriesCollection = db.collection("categories");
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

        const verifyCitizen = async (req, res, next) => {
            const email = req.token_email;
            const query = { email: email };
            const user = await usersCollection.findOne(query);

            if (!user || user.role !== "citizen") {
                return res.status(403).send({ message: "Forbidden Access" });
            }
            req.currentUser = user;
            next();
        };

        // helper
        const logTimeline = async (data) => {
            const { issueId, status, message, updatedByName, updatedByEmail, updatedByRole } = data;
            const log = {
                issueId,
                status,
                message,
                updatedByName,
                updatedByEmail,
                updatedByRole,
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

        // categories related api's
        app.get("/categories", verifyFirebaseToken, async (req, res) => {
            const searchText = req.query.searchText;
            const query = {};

            if (searchText) {
                query.categoryName = { $regex: searchText, $options: "i" };
            }

            const pipeline = [
                {
                    $match: query
                },
                {
                    $lookup: {
                        from: "issues",
                        localField: "categoryName",
                        foreignField: "category",
                        as: "issues"
                    }
                },
                {
                    $addFields: {
                        issuesCount: {
                            $size: "$issues"
                        }
                    }
                },
                {
                    $project: {
                        issues: 0
                    }
                },
                {
                    $sort: {
                        categoryName: 1,
                    }
                }
            ];

            const cursor = categoriesCollection.aggregate(pipeline);
            const result = await cursor.toArray();
            res.send(result);
        });

        app.post("/categories", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const categoryName = req.body.categoryName;
            const query = {
                categoryName: { $regex: categoryName, $options: "i" }
            };

            const categoryExists = await categoriesCollection.findOne(query);
            if (categoryExists) {
                return res.status(400).send({ message: "Category already exists" });
            }

            const category = {
                categoryName,
                createdAt: new Date()
            };

            const result = await categoriesCollection.insertOne(category);
            res.send(result);
        });

        app.patch("/categories/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const { categoryName } = req.body;

            if (!categoryName) {
                return res.status(400).send({ message: "Category name is required" });
            }

            const query = { _id: new ObjectId(id) };

            const update = {
                $set: {
                    categoryName,
                    updatedAt: new Date()
                }
            };

            const result = await categoriesCollection.updateOne(query, update);
            res.send(result);
        });

        app.delete("/categories/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await categoriesCollection.deleteOne(query);
            res.send(result);
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

        app.get("/issues/:email/limit", verifyFirebaseToken, verifyCitizen, async (req, res) => {
            const email = req.params.email;
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
                    return res.status(429).send({
                        message: "Free user issue limit exceeded. Buy premium to post more issues",
                        needSubscription: true,
                        allowPosting: false
                    });
                }
            }

            return res.status(200).send({ allowPosting: true });
        });

        app.post("/issues", verifyFirebaseToken, verifyCitizen, async (req, res) => {
            const issue = req.body;
            const email = req.token_email;
            const query = {};
            if (email) {
                query.reporterEmail = email;
            }

            const user = await usersCollection.findOne({ email });

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
                updatedByEmail: email,
                updatedByRole: "citizen"
            });

            return res.send(result);
        });

        // citizen related api's
        app.get("/citizen/stats", verifyFirebaseToken, verifyCitizen, async (req, res) => {
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

            const paymentCursor = paymentsCollection.find(query).sort({ paidAt: -1 });
            const payments = await paymentCursor.toArray();
            const totalPayments = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
            const paymentsCount = payments.length;

            res.send({
                statusStats,
                payments,
                totalPayments,
                paymentsCount
            });
        });

        app.get("/citizen/my-issue-locations", verifyFirebaseToken, verifyCitizen, async (req, res) => {
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

        app.get("/citizen/my-issues", verifyFirebaseToken, verifyCitizen, async (req, res) => {
            const { email, status, category, location } = req.query;
            const query = {};

            if (email) {
                query.reporterEmail = email;
            }

            if (req.token_email !== email) {
                return res.status(403).send({ message: "Forbidden access" });
            }

            if (status) {
                query.status = status;
            }

            if (category) {
                query.category = category;
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

        app.get("/citizen/profile", verifyFirebaseToken, verifyCitizen, async (req, res) => {
            const email = req.query.email;
            const query = {};
            if (email) {
                query.email = email;
            }

            if (req.token_email !== email) {
                return res.status(403).send({ message: "Forbidden access" });
            }

            const user = await usersCollection.findOne(query);
            res.send(user);
        });
        
        app.patch("/citizen/issues/:id", verifyFirebaseToken, verifyCitizen, async (req, res)=> {
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
                updatedByEmail: email,
                updatedByRole: "citizen"
            });

            res.send(result);
        });

        app.patch("/citizen/profile/:id", verifyFirebaseToken, verifyCitizen, async (req, res) => {
            const id = req.params.id;
            const userUpdatedData = req.body;
            const query = { _id: new ObjectId(id) };

            const user = await usersCollection.findOne(query);

            if (req.token_email !== user.email) {
                return res.status(403).send({ message: "Forbidden Access" });
            }

            const update = {
                $set: {
                    displayName: userUpdatedData.displayName
                }
            };

            if (userUpdatedData.photoURL) {
                update.$set.photoURL = userUpdatedData.photoURL;
            }

            const options = {};
            const result = await usersCollection.updateOne(query, update, options);
            res.send(result);
        });
        
        app.delete("/citizen/issues/:id", verifyFirebaseToken, verifyCitizen, async (req, res) => {
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

        // staff related api's
        app.get("/staff/overview", verifyFirebaseToken, verifyStaff, async (req, res) => {
            const email = req.token_email;

            const baseQuery = {
                assignedStaffEmail: email
            };
            
            const assignedCount = await issuesCollection.countDocuments(baseQuery);
            
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
            
            const boostedIssuesCount = await issuesCollection.countDocuments({
                assignedStaffEmail: email,
                isBoosted: true
            });
            
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

        app.get("/staff/issues", verifyFirebaseToken, verifyStaff, async (req, res) => {
            const email = req.token_email;
            const { status, priority } = req.query;
            const query = { assignedStaffEmail: email };

            if (status) {
                query.status = status;
            }
            if (priority) {
                query.priority = priority;
            }
            
            const options = {
                sort: {
                    isBoosted: -1,
                    createdAt: 1
                }
            };

            const cursor = issuesCollection.find(query, options);
            const result = await cursor.toArray();
            res.send(result);
        });
        
        app.get("/staff/profile", verifyFirebaseToken, verifyStaff, async (req, res) => {
            const email = req.query.email;
            const query = {};

            if (email) {
                query.email = email;
            }

            if (req.token_email !== email) {
                return res.status(403).send({ message: "Forbidden Access" });
            }

            const user = await usersCollection.findOne(query);
            return res.send(user);
        });
        
        app.patch("/staff/issues/:id/status", verifyFirebaseToken, verifyStaff, async (req, res) => {
            const id = req.params.id;
            const email = req.token_email;
            const displayName = req.currentUser?.name || req.currentUser?.displayName;
            const { newStatus } = req.body;

            if (!newStatus) {
                return res.status(400).send({ message: "New status is required" });
            }

            const query = { _id: new ObjectId(id) };
            const issue = await issuesCollection.findOne(query);

            if (!issue) {
                return res.status(404).send({ message: "Issue not found" });
            }
            
            // can't change if owned assigned
            if (issue.assignedStaffEmail !== email) {
                return res.status(403).send({ message: "Forbidden Access" });
            }

            // allowed transitions
            const allowedTransitions = {
                pending: ["in_progress"],
                in_progress: ["working"],
                working: ["resolved"],
                resolved: ["closed"]
            };

            const currentStatus = issue.status;
            const allowed = allowedTransitions[currentStatus] || [];

            if (!allowed.includes(newStatus)) {
                return res.status(400).send({
                    message: `Invalid status transition from ${currentStatus} to ${newStatus}`
                });
            }

            const update = {
                $set: {
                    status: newStatus,
                    updatedAt: new Date()
                }
            };

            const result = await issuesCollection.updateOne(query, update);
            
            await logTimeline({
                issueId: id,
                status: newStatus,
                message: `Status changed by staff (${currentStatus} → ${newStatus})`,
                updatedByName: displayName,
                updatedByRole: "staff",
                updatedByEmail: email
            });

            res.send(result);
        });
        
        app.patch("/staff/profile/:id", verifyFirebaseToken, verifyStaff, async (req, res) => {
            const id = req.params.id;
            const updatedProfile = req.body;
            const query = { _id: new ObjectId(id) };

            const user = await usersCollection.findOne(query);

            if (req.token_email !== user.email) {
                return res.status(403).send({ message: "Forbidden Access" });
            }

            const update = {
                $set: {
                    displayName: updatedProfile.displayName
                }
            };

            if (updatedProfile.photoURL) {
                update.$set.photoURL = updatedProfile.photoURL;
            }

            const options = {};
            const result = await usersCollection.updateOne(query, update, options);
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
            const { status, priority, category, search } = req.query;
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
            if (search) {
                query.$or = [
                    { title: { $regex: search, $options: "i" } },
                    { location: { $regex: search, $options: "i" } }
                ];
            }

            const options = { 
                sort: {
                    priority: 1, createdAt: -1
                }
            };
            const cursor = issuesCollection.find(query, options);
            const result = await cursor.toArray();
            res.send(result);
        });

        app.get("/admin/users", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const searchText = req.query.searchText;
            const query = {
                $or: [
                    { role: { $exists: false } },
                    { role: "citizen" }
                ]
            };

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
            const searchText = req.query.searchText;
            const query = { role: "staff" };

            if (searchText) {
                query.$or = [
                    { displayName: { $regex: searchText, $options: "i" } },
                    { email: { $regex: searchText, $options: "i" } },
                ];
            }

            const options = { 
                sort: {
                    createdAt: -1
                }
            };

            const cursor = usersCollection.find(query, options);
            const result = await cursor.toArray();
            res.send(result);
        });

        app.get("/admin/profile", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const email = req.query.email;
            
            if (req.token_email !== email) {
                return res.status(403).send({ message: "Forbidden Access" });
            }

            const query = { email: email };
            const user = await usersCollection.findOne(query);
            res.send(user);
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
                updatedByEmail: adminEmail,
                updatedByRole: "admin",
            });

            return res.send({
                success: result.modifiedCount > 0,
                modifiedCount: result.modifiedCount,
                matchedCount: result.matchedCount,
            });   
        });

        app.patch("/admin/issues/:id/reject", verifyFirebaseToken, verifyAdmin,async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const issue = await issuesCollection.findOne(query);

            if (issue.status !== "pending") {
                return res.status(400).send({ message: "Only pending issues can be rejected" });
            }

            const update = {
                $set: {
                    status: "rejected",
                    updatedAt: new Date(),
                }
            };

            const result = await issuesCollection.updateOne(query, update);

            await logTimeline({
                issueId: id,
                status: "rejected",
                message: "Issue rejected by admin",
                updatedByName: req.currentUser.displayName,
                updatedByEmail: req.token_email,
                updatedByRole: req.currentUser.role
            });

            res.send(result);
        });

        app.patch("/admin/profile/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const userUpdatedData = req.body;
            const query = { _id: new ObjectId(id) };

            const user = await usersCollection.findOne(query);

            if (req.token_email !== user.email) {
                return res.status(403).send({ message: "Forbidden Access" });
            }

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

        app.patch("/admin/staff/:staffEmail", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const email = req.params.staffEmail;
            const staffUpdatedData = req.body;
            const query = { email: email };

            const update = {
                $set: {
                    displayName: staffUpdatedData.displayName,
                }
            };

            if (staffUpdatedData.photoURL) {
                update.$set.photoURL = staffUpdatedData.photoURL;
            }

            const options = {};
            const result = await usersCollection.updateOne(query, update, options);
            res.send(result);
        });

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

        // payment related api's
        app.get("/admin/payments", verifyFirebaseToken, verifyAdmin, async (req, res) => {
            const { searchText, paymentType } = req.query;
            const query = {};

            if (searchText) {
                query.$or = [
                    { customerName: { $regex: searchText, $options: "i" } },
                    { customerEmail: { $regex: searchText, $options: "i" } },
                ];
            }

            if (paymentType) {
                query.paymentType = paymentType;
            }

            const cursor = paymentsCollection.find(query).sort({ paidAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        });

        // payment type -> boost_issue, subscription
        app.post("/create-checkout-session", verifyFirebaseToken, async (req, res) => {
            const paymentInfo = req.body;
            const paymentType = paymentInfo.paymentType;  // boost_issue, subscription

            let amount = 0;
            let productName = "Payment";

            if (paymentType === "boost_issue") {
                amount = 100 * 100;
                productName = `Boost issue: ${paymentInfo.issueTitle}`;
            } else if (paymentType === "subscription") {
                amount = 1000 * 100;
                productName = "Premium Subscription";
            } else {
                return res.status(400).send({ message: "Invalid payment type" });
            }

            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: "bdt",
                            product_data: {
                                name: productName,
                            },
                            unit_amount: amount,
                        },
                        quantity: 1,
                    },
                ],
                customer_email: paymentInfo.customerEmail,
                mode: "payment",
                metadata: {
                    paymentType,
                    issueId: paymentInfo.issueId || "",
                    issueTitle: paymentInfo.issueTitle || "",
                    userName: paymentInfo.customerName,
                    userEmail: paymentInfo.customerEmail,
                    userImage: paymentInfo.customerImage
                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`
            });

            res.send({ url: session.url });
        });

        app.patch("/payment-success", verifyFirebaseToken, async (req, res) => {
            const sessionId = req.query.session_id;
            const session = await stripe.checkout.sessions.retrieve(sessionId);

            if (!session.payment_intent) {
                return res.send({
                    success: false,
                    message: "No payment_intent found in Stripe session",
                });
            }

            const transactionId = session.payment_intent;
            const paymentType = session.metadata.paymentType;
            const userName = session.metadata.userName;
            const userEmail = session.metadata.userEmail;
            const userImage = session.metadata.userImage;
            const issueId = session.metadata.issueId;

            if (session.payment_status !== "paid") {
                return res.send({ success: false });
            }

            const payment = {
                amount: session.amount_total / 100,
                currency: session.currency,
                customerName: userName,
                customerEmail: session.customer_email,
                customerImage: userImage,
                transactionId,
                paymentStatus: session.payment_status,
                paymentType,
                issueId: issueId || "",
                issueTitle: session.metadata.issueTitle || "",
                paidAt: new Date()
            };

            const query = { transactionId };
            const update = { $setOnInsert: payment };
            const options = { upsert: true };
            const paymentResult = await paymentsCollection.updateOne(query, update, options);

            const newlyCreated = paymentResult.upsertedCount === 1;

            // apply business logic only once
            if (newlyCreated) {
                if (paymentType === "boost_issue" && issueId) {
                    const issueQuery = { _id: new ObjectId(issueId) };
                    const issueUpdate = {
                        $set: {
                            priority: "high",
                            isBoosted: true,
                            updatedAt: new Date(),
                        },
                    };
                    await issuesCollection.updateOne(issueQuery, issueUpdate);

                    await logTimeline({
                        issueId,
                        status: "boosted",
                        message: "Issue priority boosted (payment successful)",
                        updatedByRole: "citizen",
                        updatedByName: userName,
                        updatedByEmail: userEmail,
                    });
                }

                if (paymentType === "subscription") {
                    await usersCollection.updateOne(
                        { email: userEmail },
                        {
                            $set: {
                                isPremium: true,
                                premiumActivatedAt: new Date(),
                            },
                        }
                    );
                }
            }

            const existingPayment = await paymentsCollection.findOne({ transactionId });

            return res.send({
                success: true,
                newlyCreated,
                transactionId,
                paymentInfo: existingPayment
            });
        });

        // payment pdf related api
        app.get("/admin/payments/:id/invoice", verifyFirebaseToken, async (req, res) => {
            try {
                const id = req.params.id;
                const query = { _id: new ObjectId(id) };

                // 1. get payment data
                const payment = await paymentsCollection.findOne(query);

                if (!payment) {
                    return res.status(404).send({ message: "Payment not found" });
                }

                // 2. set pdf response header
                const fileName = `invoice-${payment.transactionId || payment._id}.pdf`;

                res.setHeader("Content-Type", "application/pdf");
                res.setHeader("Content-Disposition",`inline; filename="${fileName}"`);

                // 3. create pdf document
                const doc = new PDFDocument({ size: "A4", margin: 50 });
                
                // sending stream to the response directly
                doc.pipe(res);

                // a. pdf header
                doc.fontSize(18).text("Public Infrastructure Issue Reporting", {
                    align: "left",
                });

                doc.moveDown(0.5);

                doc.fontSize(12).text("Invoice", { align: "left" }).moveDown(1);

                // b. invoice info
                doc.fontSize(11).text(`Invoice ID: ${payment._id}`, { align: "left" });
                doc.text(`Transaction ID: ${payment.transactionId || "N/A"}`);
                doc.text(`Date: ${new Date(payment.paidAt).toLocaleString()}`);
                
                doc.moveDown(1);

                // c. customer info
                doc.fontSize(12).text("Billed To:", { underline: true });
                doc.fontSize(11).text(`Email: ${payment.customerName} - ${payment.customerEmail}`).moveDown(1);
                
                // d. payment details table type layout
                doc.fontSize(12).text("Payment Details", { underline: true }).moveDown(0.5);

                doc.fontSize(11);

                doc.text(`Payment Type    : ${payment.paymentType?.split("_")?.join(" ")}`);

                if (payment.paymentType === "boost_issue") {
                    doc.text(`Issue ID             : ${payment.issueId || "N/A"}`);
                    doc.text(`Issue Title          : ${payment.issueTitle || "N/A"}`);
                }

                doc.text(`Amount              : ${payment.amount} ${payment.currency?.toUpperCase() ||""}`);

                doc.text(`Payment Status : ${payment.paymentStatus}`);

                doc.moveDown(2);

                // doc.fontSize(10).fillColor("gray").text("This is a system generated invoice. No signature is required.", { 
                //     align: "center" 
                // });

                // 4. end pdf document
                doc.end();
            } catch {
                return res.status(500).send({ message: "Failed to generate invoice" });
            }
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