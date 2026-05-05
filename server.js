require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise'); // Note the /promise
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors({
    origin: ['https://nexus-core-system.netlify.app', 'http://localhost:5500', 'http://localhost:3000']
}));
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Create Database Connection Pool
const db = mysql.createPool(process.env.DATABASE_URL || {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});


// This creates the temporary memory box to hold verification codes!
const activeOTPs = {};

// Provide the AI with your database structure so it knows how to write queries


app.post('/api/chat', async (req, res) => {
    console.log("👉 INCOMING DATA FROM FRONTEND:", req.body);

    const { userId, sessionId, message } = req.body;

    try {
        const userMessage = req.body.message;
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

        // ==========================================
        // SAVE USER MESSAGE TO MYSQL
        // ==========================================
        const [existingSession] = await db.execute('SELECT id FROM chat_sessions WHERE id = ?', [sessionId]);
        if (existingSession.length === 0) {
            const title = userMessage.length > 30 ? userMessage.substring(0, 30) + '...' : userMessage;
            await db.execute(
                'INSERT INTO chat_sessions (id, user_id, title) VALUES (?, ?, ?)', 
                [sessionId, userId, title]
            );
        } else {
            await db.execute('UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [sessionId]);
        }

        await db.execute(
            'INSERT INTO messages (session_id, sender, message_text) VALUES (?, ?, ?)',
            [sessionId, 'user', userMessage]
        );
        console.log(`✅ Saved User Message to MySQL -> Chat: ${sessionId}`);

        
        // ==========================================
        // FETCH CHAT HISTORY FOR AI CONTEXT
        // ==========================================
        const [historyRows] = await db.execute(
            'SELECT sender, message_text FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10',
            [sessionId]
        );
        historyRows.reverse(); 

        let conversationHistory = "";
        historyRows.forEach(row => {
            const role = row.sender === 'user' ? 'User' : 'Nexus AI';
            conversationHistory += `${role}: ${row.message_text}\n`;
        });
        
        console.log("Loaded Conversation History:\n", conversationHistory);

        // ==========================================
        // STEP 1: Ask Gemini to generate an SQL query
        // ==========================================

        // 🟢 NEW: Find ONLY the tables that start with this user's ID
        const [userTables] = await db.query(`SHOW TABLES LIKE 'user_${userId}_%'`);
        
        let liveSchema = "";
        let allowedTableNames = [];

        if (userTables.length === 0) {
            liveSchema = "The user has no tables. Tell them to use the Create Connection box to build their database first.";
        } else {
            // Loop through their tables and get the exact columns for each one
            for (let row of userTables) {
                const tableName = Object.values(row)[0];
                allowedTableNames.push(tableName.toLowerCase());
                
                const [columns] = await db.query(`DESCRIBE ${tableName}`);
                const colDefs = columns.map(c => `${c.Field} (${c.Type})`).join(', ');
                liveSchema += `Table: ${tableName}\nColumns: ${colDefs}\n\n`;
            }
        }

        console.log(`Loaded Schema for User ${userId}:\n`, liveSchema);

        const sqlPrompt = `
        You are an expert database administrator for a multi-tenant SaaS. 
        Here is the LIVE schema for THIS specific user's database:

        ${liveSchema}

        CONVERSATION HISTORY (Context for pronouns/references):
        ${conversationHistory}
        
        CURRENT REQUEST: "${userMessage}"
        
        CRITICAL RULES FOR THE AI:
        1. CONTEXT IS EVERYTHING: Look at the Conversation History. If the AI previously showed a table with a specific filter, OR if the AI just inserted/updated a specific record, and the user uses pronouns like "there", "their", "those", "them", "he", "she", or "this", YOU MUST apply that exact context to the new query.
        
        AMBIGUITY & CLARIFICATION:
        2. If the user's request is vague, ambiguous, uses undefined terms (e.g., asking for the "best" or "top" employees without defining how to measure it), or asks for data that doesn't exist in the table schema, DO NOT guess or write an SQL query. Instead, ask a clear, conversational follow-up question to clarify their exact intent (e.g., "By 'top employees', do you mean the ones with the highest salary?").
        
        QUERY GENERATION:
        3. Do not query the entire table if the user is asking a follow-up question about a specific sub-group.
        4. ALWAYS include the relevant data columns in your SELECT statement (e.g., if asking for highest salary, SELECT name, salary).
        5. HANDLING TIES: When a user asks for ranked data (e.g., "highest", "top 3", "second highest"), you MUST account for ties. If multiple rows share the same value, your SQL MUST return all of them. Use window functions like DENSE_RANK() or subqueries. NEVER use a simple LIMIT clause if it risks cutting off tied records.
        
        DATA INSERTION PROTOCOL:
        5. When a user asks to add, insert, or create new data, DO NOT generate an SQL query immediately. First, verify if the user provided all required column values (Name, Department, Salary).
        6. If details are missing, DO NOT write an SQL query. Instead, ask a conversational follow-up question for the missing details. NEVER guess, hallucinate, or make up data. NEVER manually assign an 'id' like '1' (it will auto-increment).
        
        OUTPUT FORMATTING (CRITICAL):
        7. STRICT SQL OUTPUT: If you are generating an SQL query, your response MUST start immediately with the SQL command (SELECT, INSERT, UPDATE, DELETE, or ALTER). NEVER write your thought process, reasoning, or introductory text. DO NOT explain yourself. Return ONLY the raw query.
        8. If you are asking a follow-up question for missing data (Rule 6) OR clarifying an ambiguous request (Rule 2), return ONLY the plain text question. Do not use SQL formatting or markdown blocks.
        
        SCHEMA MODIFICATION (ALTER TABLE):
        9. If a user asks to add or remove a column in a table, DO NOT generate the SQL immediately. First, ask for the data type (e.g., INT, VARCHAR) if they didn't provide one. Once they provide the data type, return ONLY the raw 'ALTER TABLE' SQL query.
        
        SCHEMA VALIDATION RULES:
        10. If the user asks to create a new table, IMMEDIATELY check the LIVE schema provided above.
        11. If the requested table name already exists in their schema (ignoring prefixes), DO NOT ask for columns or generate SQL. Politely inform them that the table already exists and ask if they want to choose a different name or modify the existing one.
        12. MULTI-TENANT SECRECY: Never reveal the 'user_${userId}_' prefix in your conversational responses. If you must name a table to the user, strip the prefix (e.g., call it 'cloths' instead of 'user_9_cloths').
        
        META-QUERIES & DATABASE STATE:
        13. If the user asks general questions like "which tables have data", "how many records do I have", or "show me table sizes", DO NOT ask for permission to write the query. You MUST immediately generate a single SQL query using 'UNION ALL' to get the COUNT(*) of every table provided in the LIVE schema. 
        Example format: 
        SELECT 'table1' AS Table_Name, COUNT(*) AS Total_Rows FROM table1 
        UNION ALL 
        SELECT 'table2', COUNT(*) FROM table2;

        `;

        const sqlResult = await model.generateContent(sqlPrompt);


        let rawAiResponse = sqlResult.response.text().trim();
        let rawQuery = rawAiResponse;

        // SMART EXTRACTOR: If the AI accidentally talks but puts the SQL in a ```sql block, pull ONLY the code!
        const sqlMatch = rawAiResponse.match(/```sql([\s\S]*?)```/i);
        if (sqlMatch) {
            rawQuery = sqlMatch[1].trim(); 
        } else {
            // Clean up any stray backticks just in case
            rawQuery = rawQuery.replace(/```sql|```/ig, '').trim();
        }


        console.log("AI Generated Output:", rawQuery);

        // ==========================================
        // 🟢 THE FIX: Check if it's SQL or a Question!
        // ==========================================
        const isSqlQuery = rawQuery.toUpperCase().startsWith('SELECT') || 
                           rawQuery.toUpperCase().startsWith('INSERT') || 
                           rawQuery.toUpperCase().startsWith('UPDATE') || 
                           rawQuery.toUpperCase().startsWith('DELETE') ||
                           rawQuery.toUpperCase().startsWith('ALTER');

        if (isSqlQuery) {
            
            console.log("AI wrote an SQL query. Inspecting for security...");
            
            // ==========================================
            // 🟢 NEW: THE SECURITY GATEKEEPER
            // ==========================================
            const queryLower = rawQuery.toLowerCase();
            
            // 1. Block access to system tables
            const forbiddenTables = [' users', ' chat_sessions', ' messages'];
            const isForbidden = forbiddenTables.some(t => queryLower.includes(t));
            
            // 2. Ensure the query actually targets their specific table prefix
            const hasUserPrefix = queryLower.includes(`user_${userId}_`);

            if (isForbidden || (!hasUserPrefix && allowedTableNames.length > 0)) {
                console.error(`🚨 SECURITY ALERT: Blocked unauthorized query from User ${userId} ->`, rawQuery);
                
                const blockMessage = "I can only access the custom tables you created in your setup. I cannot access system data or other databases.";
                
                await db.execute('INSERT INTO messages (session_id, sender, message_text) VALUES (?, ?, ?)', [sessionId, 'ai', blockMessage]);
                return res.json({ reply: blockMessage });
            }

            console.log("Query passed security check. Executing...");
            
            // ==========================================
            // STEP 2: Execute the Query in Node.js
            // ==========================================
            let dbData = "No data retrieved"; 
            
            try {
                const individualQueries = rawQuery.split(';').filter(q => q.trim() !== '');
                let allResults = [];

                for (let singleQuery of individualQueries) {
                    // Execute each query separately
                    const [rows] = await db.execute(singleQuery.trim());
                    allResults.push(rows);
                }
                
                dbData = JSON.stringify(allResults);
                console.log("Database Results:", dbData);
            } catch (dbError) {
                console.error("Database execution failed:", dbError.message);
                dbData = `Error executing query: ${dbError.message}`;
            }

            // ==========================================
            // STEP 3: Ask Gemini to summarize the data
            // ==========================================
            const summaryPrompt = `
            CONVERSATION HISTORY (Use this to understand what the user is referring to):
            ${conversationHistory}

            The user asked: "${userMessage}"
            
            I attempted to retrieve data from my database for this request. Here is the result of that attempt: 
            ${dbData}
            
            System Instruction (Contextual Presentation):
            You are Nexus ai, a database assistant. Your job is to analyze the inputs and follow these rules precisely to craft the final answer:

            NEVER use DISTINCT inside a window function (e.g., do NOT use COUNT(DISTINCT column) OVER()). 
            
            If you need to return a total distinct count alongside individual rows, use a standard subquery instead, like: (SELECT COUNT(DISTINCT column) FROM table).
            
            Whenever you retrieve and display database records in a table, you MUST always include the name column as the very first column in your markdown table or plain text. Avoid to display id column only, untill the user specifically ask it.

            1.  **Rule for valid Data Results:** If the database result contains valid, non-error database rows (a JSON list of objects), and the user is asking a data-related question (e.g., "show me", "list", "tell me about"), then you must format this data as a clean, beautiful Markdown table. Add a brief, friendly introductory sentence.
            
            2.  **Rule for Non-Data Questions (like hii,how are , can tell me something):** If the user is just having a casual chat, asking for a general information about else, or asking a question that is clearly NOT about database data, respond with a friendly, conversational text answer. Do NOT use a table in this case. Just have a normal conversation.
            
            3.  **Rule for Errors:** If the database result is an error message, explain the error to the user in simple, friendly terms.

            4.  **Always format currency using the Indian Rupee symbol (₹) instead of the Dollar symbol ($).

            5.  **If user ask a question, which give a single or double line answers, in a number or word, use the bullet points and other fucntionality to display and make it professional look.

            6.  **when user ask about engineers, but in the records there is engineering and that time you give a engineering records to user, don't tell there is no records about engineers, same as testing ,tester, the words what ever the users give related words in the record match the words if it gives same relationship then get the record and give it to the user. 
            
            7.  **STRICT COLUMN SELECTION: You must ONLY select and return the exact columns the user explicitly asks for. If the user asks for "salary", your SQL query must only be SELECT salary FROM table. Do NOT add names, IDs, or departments to provide "context" unless the user explicitly requests them.
            
            8.  **ALWAYS INCLUDE VALUES:** If the database results contain specific numbers, amounts, or values (such as a salary of 90000), you MUST explicitly include those exact numbers in your final written response. Never just give the name; always state the value too.

            9. **MULTI-TENANT SECRECY:** Never reveal the 'user_${userId}_' prefix when naming tables. Always call them by their base name (e.g., 'cloths', 'electronics').

            Final Constraint: Do not mention technical implementation details (like SQL or how you got the data). Just answer the user directly and friendly.
            `;

            const finalResult = await model.generateContent(summaryPrompt);
            let aiText = finalResult.response.text();

            // ==========================================
            // 🪄 SANITIZE AI SUMMARY (Remove user prefix)
            // ==========================================
            const prefixRegex = new RegExp(`user_${userId}_`, 'g');
            aiText = aiText.replace(prefixRegex, '');

            // ==========================================
            // SAVE AI MESSAGE TO MYSQL
            // ==========================================
            await db.execute(
                'INSERT INTO messages (session_id, sender, message_text) VALUES (?, ?, ?)',
                [sessionId, 'ai', aiText]
            );
            console.log(`✅ Saved AI Summary Message to MySQL -> Chat: ${sessionId}`);

            res.json({ reply: aiText });

        } else {
            // ==========================================
            // AI ASKED A QUESTION (Skipping DB & Summary)
            // ==========================================
            console.log("AI asked a clarification question. Skipping database.");
            
            // ==========================================
            // 🪄 SANITIZE AI QUESTION (Remove user prefix)
            // ==========================================
            const prefixRegex = new RegExp(`user_${userId}_`, 'g');
            const cleanAiQuestion = rawQuery.replace(prefixRegex, '');
            
            await db.execute(
                'INSERT INTO messages (session_id, sender, message_text) VALUES (?, ?, ?)',
                [sessionId, 'ai', cleanAiQuestion] // 🟢 Save clean version!
            );
            console.log(`✅ Saved AI Question Message to MySQL -> Chat: ${sessionId}`);

            res.json({ reply: cleanAiQuestion }); // 🟢 Send clean version!
        }

    } catch (error) {
        console.error("AI Generation Error:", error);

        let aiFallbackMessage = "⚠️ Core system error. I lost connection to the AI processing unit. Please try again.";

        if (error.status === 429) {
            aiFallbackMessage = "⚠️ I have answered too many questions today! My daily free quota has been reached.";
        } else if (error.status === 503) {
            aiFallbackMessage = "⏳ Google's AI servers are currently experiencing unusually high traffic. Please wait a minute and try again!";
        }

        try {
            await db.execute(
                'INSERT INTO messages (session_id, sender, message_text) VALUES (?, ?, ?)',
                [sessionId, 'ai', aiFallbackMessage]
            );
        } catch (dbError) {
            console.error("Could not save fallback message to DB:", dbError);
        }

        res.json({ reply: aiFallbackMessage });
    }
});

// ==========================================
// SAVE USER THEME PREFERENCE
// ==========================================
app.put('/api/users/:userId/theme', async (req, res) => {
    try {
        const userId = req.params.userId;
        const newTheme = req.body.theme; 
        
        await db.execute('UPDATE users SET theme = ? WHERE id = ?', [newTheme, userId]);
        res.json({ success: true });
    } catch (error) {
        console.error("Error saving theme:", error);
        res.status(500).json({ error: "Failed to save theme" });
    }
});


// ==========================================
// FETCH USER CHAT HISTORY
// ==========================================
app.get('/api/chats/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // 1. Get all chat sessions for this user (newest first)
        const [sessions] = await db.execute(
            'SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC',
            [userId]
        );

        // If they have no chats, send back an empty array
        if (sessions.length === 0) {
            return res.json([]); 
        }

        // 2. Get all the individual messages for those sessions
        const sessionIds = sessions.map(s => s.id);
        const placeholders = sessionIds.map(() => '?').join(','); // Creates ?,?,? for SQL
        const [messages] = await db.execute(
            `SELECT * FROM messages WHERE session_id IN (${placeholders}) ORDER BY created_at ASC`,
            sessionIds
        );

        // 3. Format the data to match your frontend 'chats' array perfectly!
        const formattedChats = sessions.map(session => {
            return {
                id: session.id,
                title: session.title,
                isPinned: session.is_pinned === 1, // Converts MySQL 1/0 to true/false
                messages: messages
                    .filter(msg => msg.session_id === session.id)
                    .map(msg => ({
                        text: msg.message_text,
                        sender: msg.sender,
                        time: new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    }))
            };
        });

        // ==========================================
        // DELETE A CHAT SESSION
        // ==========================================
        app.delete('/api/chats/:sessionId', async (req, res) => {
            try {
                const sessionId = req.params.sessionId;
        
                // Delete the session from MySQL
                await db.execute('DELETE FROM chat_sessions WHERE id = ?', [sessionId]);
        
                console.log(`🗑️ Deleted Chat from MySQL -> Chat: ${sessionId}`);
                res.json({ success: true });
            } catch (error) {
                console.error("Error deleting chat:", error);
                res.status(500).json({ error: "Failed to delete chat" });
            }
        });
       
        // ==========================================
        // RENAME A CHAT SESSION
        // ==========================================
        app.put('/api/chats/:sessionId/rename', async (req, res) => {
            try {
                const sessionId = req.params.sessionId;
                const newTitle = req.body.title; // The new name from the frontend
        
                await db.execute('UPDATE chat_sessions SET title = ? WHERE id = ?', [newTitle, sessionId]);
                res.json({ success: true });
            } catch (error) {
                console.error("Error renaming chat:", error);
                res.status(500).json({ error: "Failed to rename chat" });
            }
        });

        // ==========================================
        // PIN / UNPIN A CHAT SESSION
        // ==========================================
        app.put('/api/chats/:sessionId/pin', async (req, res) => {
            try {
                const sessionId = req.params.sessionId;
                const isPinned = req.body.isPinned; 
        
                // Convert JavaScript true/false into MySQL 1/0
                const pinValue = isPinned ? 1 : 0; 
        
                await db.execute('UPDATE chat_sessions SET is_pinned = ? WHERE id = ?', [pinValue, sessionId]);
                res.json({ success: true });
            } catch (error) {
                console.error("Error pinning chat:", error);
                res.status(500).json({ error: "Failed to pin chat" });
            }
        });

        res.json(formattedChats);

    } catch (error) {
        console.error("Error fetching history:", error);
        res.status(500).json({ error: "Failed to load history" });
    }
});


// ==========================================
// GET USER SCHEMA FOR DYNAMIC UI PILLS
// ==========================================
app.get('/api/users/:userId/schema', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // Find this user's tables
        const [userTables] = await db.query(`SHOW TABLES LIKE 'user_${userId}_%'`);
        
        if (userTables.length === 0) {
            return res.json({ success: true, hasData: false });
        }

        // Pick the first table they created to use for the suggestions
        const fullTableName = Object.values(userTables[0])[0];
        const cleanTableName = fullTableName.replace(`user_${userId}_`, '');

        // Get the columns for that table
        const [columns] = await db.query(`DESCRIBE ${fullTableName}`);
        
        // Filter out the 'id' column so we get meaningful columns like 'brand' or 'name'
        const colNames = columns.filter(c => c.Field !== 'id').map(c => c.Field);

        res.json({
            success: true,
            hasData: true,
            tableName: cleanTableName,
            columns: colNames
        });

    } catch (error) {
        console.error("Error fetching user schema:", error);
        res.status(500).json({ success: false, error: "Database error" });
    }
});


// ==========================================
// LOGIN ENDPOINT
// ==========================================
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Query the database to find the user
        const [users] = await db.execute(
            'SELECT * FROM users WHERE username = ? AND password = ?', 
            [username, password]
        );

        if (users.length > 0) {
            // Success! Send back all the user profile data
            const loggedInUser = users[0];
            res.json({ 
                success: true, 
                user: {
                    id: loggedInUser.id,
                    username: loggedInUser.username,
                    fullName: loggedInUser.full_name || loggedInUser.username, // Fallback if name is blank
                    contact: loggedInUser.contact,
                    theme: loggedInUser.theme || 'light',

                    role: loggedInUser.role || 'Admin',
                    field_type: loggedInUser.field_type || 'Technology',
                    email_id: loggedInUser.email_id || '',
                    contact: loggedInUser.contact || ''
                }
            });
        } else {
            res.status(401).json({ success: false, error: "Invalid User ID or Password" });
        }

    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ success: false, error: "Database connection failed." });
    }
});


// ==========================================
// 3. ROUTE TO UPDATE THE DATABASE (ASYNC FIX)
// ==========================================
app.post('/api/reset-password', async (req, res) => {
    console.log("\n--- NEW PASSWORD RESET REQUEST ---");
    const { username, newPassword } = req.body;
    console.log("1. Received reset request for:", username);

    if (!username || !newPassword) {
        console.log("❌ Missing fields!");
        return res.json({ success: false, error: "Missing required fields." });
    }

    console.log("2. Asking MySQL to update the password...");
    
    try {
        // THE FIX: We MUST use 'await' here so the server actually waits for the answer!
        const [result] = await db.query(
            "UPDATE users SET password = ? WHERE username = ?", 
            [newPassword, username]
        );
        
        console.log("3. MySQL Database responded!");

        if (result.affectedRows === 0) {
            console.log("❌ Failed: User not found in DB.");
            return res.json({ success: false, error: "User ID not found." });
        }

        console.log(`✅ Success: Password reset perfectly for user '${username}'`);
        res.json({ success: true });

    } catch (err) {
        // If the database has an error, it will loudly print it here instead of freezing!
        console.error("❌ DB Update Error:", err);
        res.json({ success: false, error: "Database error." });
    }
});


// ==========================================
// UPDATE USER PROFILE (EMAIL & CONTACT)
// ==========================================
app.put('/api/users/:userId/profile', async (req, res) => {
    try {
        const userId = req.params.userId;
        const { email_id, contact } = req.body; 
        
        // Make sure your database columns are actually named 'email_id' and 'contact'!
        await db.execute(
            'UPDATE users SET email_id = ?, contact = ? WHERE id = ?', 
            [email_id, contact, userId]
        );
        res.json({ success: true });
    } catch (error) {
        console.error("Profile update error:", error);
        res.status(500).json({ error: "Failed to update profile" });
    }
});


// ==========================================
// 1. ROUTE TO GENERATE & SEND EMAIL OTP (FORGOT PASSWORD)
// ==========================================
app.post('/api/send-otp', async (req, res) => {
    console.log("\n--- NEW OTP REQUEST STARTED (BREVO API) ---");
    const { username } = req.body;

    try {
        const [users] = await db.query("SELECT email_id FROM users WHERE username = ?", [username]);
        
        if (users.length === 0) {
            return res.json({ success: false, error: "User ID not found." });
        }

        const userEmail = users[0].email_id;
        if (!userEmail) {
             return res.json({ success: false, error: "No email address registered." });
        }

        const generatedOTP = Math.floor(1000 + Math.random() * 9000).toString();
        activeOTPs[username] = generatedOTP;

        setTimeout(() => {
            delete activeOTPs[email];
            console.log(`OTP for ${email} has expired.`);
        }, 300000);

        console.log("\n--- DEBUGGING ---");
        console.log("Does the server see the key?: ", process.env.BREVO_API_KEY ? "YES!" : "NO! IT IS EMPTY.");
        if (process.env.BREVO_API_KEY) {
            console.log("Key starts with: ", process.env.BREVO_API_KEY.substring(0, 10) + "...");
        }
        console.log("-----------------\n");

        const cleanApiKey = process.env.BREVO_API_KEY.replace(/['"]/g, '').trim();

        // Brevo API Fetch Request
        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'api-key': cleanApiKey          // 👈 PASTE YOUR KEY HERE
            },
            body: JSON.stringify({
                sender: { name: "Nexus Core System", email: "systemnexuscore@gmail.com" },
                to: [{ email: userEmail }],
                subject: "NEXUS Security: Your Verification Code",
                htmlContent: `
                    <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
                        <h2>NEXUS CORE SYSTEM</h2>
                        <p>A password reset was requested for the Username: <strong>${username}</strong></p>
                        <p>Your 4-digit authorization code is:</p>
                        <h1 style="color: #0284c7; font-size: 40px; letter-spacing: 5px;">${generatedOTP}</h1>
                        <p style="color: #5f6368; font-size: 12px;">If you did not request this, please ignore this email.</p>
                    </div>
                `
            })
        });

        if (response.ok) {
            console.log("✅ Brevo Email Sent Successfully!");
            const [name, domain] = userEmail.split('@');
            const maskedEmail = name.length > 2 
                ? `${name[0]}***${name[name.length - 1]}@${domain}` 
                : `***@${domain}`;

            res.json({ success: true, maskedContact: maskedEmail });
        } else {
            const errorData = await response.json();
            console.error("⚠️ BREVO API ERROR:", errorData);
            res.json({ success: false, error: "Email API rejected the request." });
        }

    } catch (err) {
        console.error("SERVER ERROR:", err);
        return res.json({ success: false, error: "Database error." });
    }
});


// ==========================================
// 2. ROUTE TO GENERATE & SEND EMAIL OTP (NEW REGISTRATION)
// ==========================================
app.post('/api/register-send-otp', async (req, res) => {
    console.log("\n--- NEW REGISTRATION OTP REQUEST (BREVO API) ---");
    const { email, name } = req.body;
    
    const generatedOTP = Math.floor(1000 + Math.random() * 9000).toString();
    activeOTPs[email] = generatedOTP; 

    setTimeout(() => {
    delete activeOTPs[email];
    console.log(`OTP for ${email} has expired.`);
    }, 300000);

    try {
        
        const cleanApiKey = process.env.BREVO_API_KEY.replace(/['"]/g, '').trim();

        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'api-key': cleanApiKey  // 👈 PASTE YOUR KEY HERE
            },
            body: JSON.stringify({
                sender: { name: "Nexus Core System", email: "systemnexuscore@gmail.com" },
                to: [{ email: email }],
                subject: "NEXUS Security: Account Registration",
                htmlContent: `
                    <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
                        <h2>WELCOME TO NEXUS CORE</h2>
                        <p>Hello ${name}, to complete your registration, please use the verification code below:</p>
                        <h1 style="color: #0080ff; font-size: 40px; letter-spacing: 5px;">${generatedOTP}</h1>
                    </div>
                `
            })
        });

        if (response.ok) {
            console.log("✅ Brevo Registration Email Sent!");
            res.json({ success: true });
        } else {
            const errorData = await response.json();
            console.error("⚠️ BREVO API ERROR:", errorData);
            res.json({ success: false, error: "Failed to send email via API." });
        }
    } catch (error) {
        console.error("SERVER ERROR:", error);
        res.json({ success: false, error: "Server connection failed." });
    }
});



// ==========================================
// 2. ROUTE TO VERIFY OTP
// ==========================================
app.post('/api/verify-otp', (req, res) => {
    const { username, otp } = req.body;

    // Check if the OTP matches the one we saved for this user
    if (activeOTPs[username] && activeOTPs[username] === otp) {
        // Clear the OTP so it can't be used again
        delete activeOTPs[username]; 
        res.json({ success: true });
    } else {
        res.json({ success: false, error: "Invalid or expired OTP." });
    }
});


//---------------------------------------------------------------


// ==========================================
// REGISTRATION FLOW: STEP 1 - Check Email
// ==========================================
app.post('/api/check-email', async (req, res) => {
    try {
        const { email } = req.body;
        const [users] = await db.query('SELECT email_id FROM users WHERE email_id = ?', [email]);
        // If length is > 0, the email exists
        res.json({ exists: users.length > 0 });
    } catch (err) {
        console.error("Check Email Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});



// ==========================================
// REGISTRATION FLOW: STEP 3 - Verify OTP
// ==========================================
app.post('/api/register-verify-otp', (req, res) => {
    const { email, otp } = req.body;

    if (activeOTPs[email] && activeOTPs[email] === otp) {
        delete activeOTPs[email]; // Clear it after success
        res.json({ success: true });
    } else {
        res.json({ success: false, error: "Invalid or expired OTP." });
    }
});

// ==========================================
// REGISTRATION FLOW: STEP 4 - Save User
// ==========================================
app.post('/api/register', async (req, res) => {
    try {
        const { fullName, email_id, password } = req.body;
        
        // Auto-generate a username from the first part of their email
        const username = email_id.split('@')[0];

        // 🟢 FIX: Add "const [result] =" to capture the MySQL response
        const [result] = await db.execute(
            'INSERT INTO users (username, full_name, email_id, password, role, field_type, theme) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [username, fullName, email_id, password, 'User', 'General', 'system']
        );
        
        // 🟢 FIX: Send back the brand new user ID (insertId) to the frontend
        res.json({ 
            success: true, 
            userId: result.insertId 
        });
    } catch (err) {
        console.error("Database Registration Error:", err);
        res.status(500).json({ success: false, error: "Registration failed." });
    }
});


// ==========================================
// INITIALIZE USER SCHEMA (VISUAL & RAW SQL)
// ==========================================
app.post('/api/schema/initialize', async (req, res) => {
    console.log("\n--- NEW SCHEMA INITIALIZATION ---");
    const { userId, dbName, dbUser, dbPass, tables, rawSql } = req.body;

    if (!userId) return res.json({ success: false, error: "Missing user ID." });
    if ((!tables || tables.length === 0) && !rawSql) {
        return res.json({ success: false, error: "Missing table data or SQL." });
    }

    try {
        // Save Logical Credentials
        await db.query(
            'UPDATE users SET logical_db_name = ?, logical_db_user = ?, logical_db_pass = ? WHERE id = ?',
            [dbName, dbUser, dbPass, userId]
        );
        console.log(`Saved logical database '${dbName}' for User ${userId}`);

        // ------------------------------------------
        // ROUTE A: VISUAL BUILDER
        // ------------------------------------------
        if (tables && tables.length > 0) {
            
            // 🟢 GUARDRAIL 1: TABLE LIMIT (MAX 5)
            const [existingTables] = await db.query(`SHOW TABLES LIKE 'user_${userId}_%'`);
            if ((existingTables.length + tables.length) > 5) {
                return res.json({ success: false, error: "Free tier limit reached: Maximum 5 tables allowed." });
            }

            for (let table of tables) {
                // 🟢 GUARDRAIL 2: COLUMN LIMIT (MAX 30)
                if (table.columns && table.columns.length > 30) {
                    return res.json({ 
                        success: false, 
                        error: `Limit reached: Table '${table.tableName}' has ${table.columns.length} columns. Maximum allowed is 30.` 
                    });
                }

                const prefixedTableName = `user_${userId}_${table.tableName}`;
                let columnDefinitions = [];
                for (let col of table.columns) {
                    let colString = `${col.name} ${col.type}`;
                    if (col.isPk) colString += " PRIMARY KEY";
                    if (col.isAi) colString += " AUTO_INCREMENT";
                    columnDefinitions.push(colString);
                }
                const createTableSql = `CREATE TABLE IF NOT EXISTS ${prefixedTableName} (${columnDefinitions.join(', ')});`;
                console.log(`Executing Visual: ${createTableSql}`);
                await db.query(createTableSql);
            }
        } 
        
        // ------------------------------------------
        // ROUTE B: RAW SQL BUILDER
        // ------------------------------------------
        else if (rawSql) {
            console.log(`Processing Raw SQL for User ${userId}...`);
            
            // Split multiple commands by semicolon
            const queries = rawSql.split(';').filter(q => q.trim() !== '');
            
            for (let query of queries) {
                let cleanQuery = query.trim();
                
                // 🪄 1. INTERCEPT 'CREATE DATABASE'
                const createDbMatch = cleanQuery.match(/^CREATE\s+DATABASE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`'"]?[a-zA-Z0-9_]+[`'"]?)/i);
                
                if (createDbMatch) {
                    let extractedDbName = createDbMatch[1].replace(/[`'"]/g, '');
                    console.log(`Intercepted CREATE DATABASE. Saving '${extractedDbName}' logically for User ${userId}.`);
                    await db.query('UPDATE users SET logical_db_name = ? WHERE id = ?', [extractedDbName, userId]);
                    continue; 
                }

                // 🪄 2. INTERCEPT 'USE' COMMAND
                if (/^USE\s+/i.test(cleanQuery)) {
                    console.log("Intercepted USE command. Skipping context switch.");
                    continue; 
                }

                // 🚨 3. SECURITY GATEKEEPER
                if (/drop\s+database|alter\s+database|truncate|users|messages|chat_sessions/i.test(cleanQuery)) {
                    console.error(`🚨 BLOCKED MALICIOUS SQL FROM USER ${userId}:`, cleanQuery);
                    throw new Error("Action blocked by Nexus Security. You cannot modify system tables or architectures.");
                }

                // 🟢 GUARDRAIL 3: RAW SQL TABLE & COLUMN LIMIT CHECK
                const createTableMatch = cleanQuery.match(/create\s+table\s+(?:if\s+not\s+exists\s+)?[`'"]?[a-z0-9_]+[`'"]?\s*\(([^;]+)\)/i);
                if (createTableMatch) {
                    // Check Table Count
                    const [existingTables] = await db.query(`SHOW TABLES LIKE 'user_${userId}_%'`);
                    if (existingTables.length >= 5) {
                        return res.json({ success: false, error: "Free tier limit reached: Maximum 5 tables allowed." });
                    }
                    // Check Column Count
                    const columnDefinitions = createTableMatch[1].split(',');
                    if (columnDefinitions.length > 30) {
                        return res.json({ success: false, error: "Free tier limit reached: Maximum 30 columns per table allowed." });
                    }
                }

                // 🟢 GUARDRAIL 4: RAW SQL ROW LIMIT CHECK
                const insertMatch = cleanQuery.match(/(INSERT\s+INTO\s+)([`'"]?[a-zA-Z0-9_]+[`'"]?)/i);
                if (insertMatch) {
                    let strippedTable = insertMatch[2].replace(/[`'"]/g, '');
                    // Determine the actual table name in the DB
                    const actualTableName = strippedTable.startsWith(`user_${userId}_`) ? strippedTable : `user_${userId}_${strippedTable}`;
                    
                    try {
                        const [countResult] = await db.query(`SELECT COUNT(*) as total FROM ${actualTableName}`);
                        if (countResult[0].total >= 100) {
                            return res.json({ 
                                success: false, 
                                error: `Row limit reached! The table '${strippedTable.replace(`user_${userId}_`, '')}' already contains 100 rows.` 
                            });
                        }
                    } catch (err) {
                        // Table doesn't exist yet; ignore and let MySQL handle any subsequent errors
                    }
                }

                // 🪄 4. MAGIC REGEX PARSER: Automatically rewrite table names
                cleanQuery = cleanQuery.replace(/(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)([`'"]?[a-zA-Z0-9_]+[`'"]?)/gi, (match, sqlCommand, rawTableName) => {
                    let strippedTable = rawTableName.replace(/[`'"]/g, ''); 
                    return `${sqlCommand} user_${userId}_${strippedTable}`;
                });
                
                cleanQuery = cleanQuery.replace(/(INSERT\s+INTO\s+)([`'"]?[a-zA-Z0-9_]+[`'"]?)/gi, (match, sqlCommand, rawTableName) => {
                    let strippedTable = rawTableName.replace(/[`'"]/g, ''); 
                    // Prevent double-prefixing if the user somehow typed the prefix manually
                    if (strippedTable.startsWith(`user_${userId}_`)) return `${sqlCommand} ${strippedTable}`;
                    return `${sqlCommand} user_${userId}_${strippedTable}`;
                });

                console.log(`Executing Raw SQL: ${cleanQuery}`);
                await db.query(cleanQuery);
            }
        }

        console.log(`✅ Schema created successfully for User ${userId}`);
        res.json({ success: true });

    } catch (error) {
        console.error("❌ Schema Creation Error:", error);

        let safeErrorMessage = error.message;
        const prefixRegex = new RegExp(`user_${userId}_`, 'g');
        safeErrorMessage = safeErrorMessage.replace(prefixRegex, '');

        // 🟢 FIXED: Switched error.message to safeErrorMessage so the prefix stays hidden!
        res.json({ success: false, error: safeErrorMessage });
    }
});


// 🟢 FIXED: Get User's Current Table Count
app.get('/api/schema/status/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // 🟢 THE TYPO FIX: Changed 'pool.query' to 'db.query'
        const [tables] = await db.query(`SHOW TABLES LIKE 'user_${userId}_%'`);
        
        res.json({ success: true, count: tables.length });
    } catch (error) {
        console.error("Status Route Error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch table count." });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend Server running on port ${PORT}`);
});