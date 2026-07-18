// Vercel Serverless Function for Qudurat-Craft Persistent User Accounts (/api/auth.js)
import fs from 'fs';
import path from 'path';

const MASTER_INDEX_BLOB_ID = "019f7232-93d8-7e07-bfd4-40cd49cd6c4f";

function getLocalUsersDB() {
    try {
        const filePath = path.join(process.cwd(), 'users_db.json');
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(content).users || {};
        }
    } catch (e) {
        console.error("Local users_db read error:", e);
    }
    return {};
}

async function getMasterIndex() {
    try {
        const res = await fetch(`https://jsonblob.com/api/jsonBlob/${MASTER_INDEX_BLOB_ID}`, {
            headers: { 
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QuduratApp'
            }
        });
        if (res.ok) {
            const data = await res.json();
            return data.users || {};
        }
    } catch (e) {
        console.error("Fetch master index error:", e);
    }
    return {};
}

async function updateMasterIndex(usersMap) {
    try {
        await fetch(`https://jsonblob.com/api/jsonBlob/${MASTER_INDEX_BLOB_ID}`, {
            method: 'PUT',
            headers: { 
                'Content-Type': 'application/json', 
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QuduratApp'
            },
            body: JSON.stringify({ users: usersMap, updated_at: new Date().toISOString() })
        });
    } catch (e) {
        console.error("Master index update error:", e);
    }
}

export default async function handler(req, res) {
    // Set CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const { action } = req.query;
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const localUsers = getLocalUsersDB();

        if (action === 'register') {
            const { username, password, progress } = body || {};
            if (!username || !password) {
                return res.status(400).json({ error: 'يرجى كتابة اسم المستخدم وكلمة المرور' });
            }
            const cleanUsername = username.trim().toLowerCase();
            const usersIndex = await getMasterIndex();

            if (usersIndex[cleanUsername] || localUsers[cleanUsername]) {
                return res.status(400).json({ error: 'اسم المستخدم مسجل بالفعل. يرجى اختيار اسم جديد أو تسجيل الدخول.' });
            }

            const userPayload = {
                username: cleanUsername,
                password: password,
                progress: progress || {},
                created_at: new Date().toISOString()
            };

            const createRes = await fetch('https://jsonblob.com/api/jsonBlob', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json', 
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QuduratApp'
                },
                body: JSON.stringify(userPayload)
            });

            if (createRes.ok) {
                const rawLocation = createRes.headers.get('Location') || createRes.headers.get('x-jsonblob-id');
                const userBlobId = rawLocation ? rawLocation.split('/').pop() : null;
                if (userBlobId) {
                    usersIndex[cleanUsername] = { password: password, blobId: userBlobId };
                    await updateMasterIndex(usersIndex);
                }
            }

            return res.status(200).json({
                success: true,
                user: { username: cleanUsername },
                progress: userPayload.progress
            });
        }

        if (action === 'login') {
            const { username, password } = body || {};
            if (!username || !password) {
                return res.status(400).json({ error: 'يرجى كتابة اسم المستخدم وكلمة المرور' });
            }

            const cleanUsername = username.trim().toLowerCase();
            const localUser = localUsers[cleanUsername];
            const usersIndex = await getMasterIndex();
            const userMeta = usersIndex[cleanUsername];

            if (!userMeta && !localUser) {
                return res.status(404).json({ error: 'اسم المستخدم غير موجود. يرجى التثبت من الاسم أو إنشاء حساب جديد' });
            }

            let userProgressData = localUser ? (localUser.progress || {}) : {};

            if (userMeta) {
                try {
                    const userBlobRes = await fetch(`https://jsonblob.com/api/jsonBlob/${userMeta.blobId}`, {
                        headers: { 
                            'Accept': 'application/json',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QuduratApp'
                        }
                    });

                    if (userBlobRes.ok) {
                        const userData = await userBlobRes.json();
                        const cloudProg = userData.progress || {};
                        
                        // Smart merge local seeded progress + cloud progress
                        const cloudComp = cloudProg.completed || {};
                        const localComp = userProgressData.completed || {};
                        userProgressData.completed = { ...cloudComp, ...localComp };

                        const cloudMistakes = cloudProg.incorrectQuestions || [];
                        const localMistakes = userProgressData.incorrectQuestions || [];
                        const seenTitles = new Set();
                        const mergedMistakes = [];
                        for (const m of [...localMistakes, ...cloudMistakes]) {
                            if (m && m.title && !seenTitles.has(m.title)) {
                                seenTitles.add(m.title);
                                mergedMistakes.push(m);
                            }
                        }
                        userProgressData.incorrectQuestions = mergedMistakes;
                    }
                } catch (e) {
                    console.error("Cloud fetch user blob error:", e);
                }
            }

            return res.status(200).json({
                success: true,
                user: { username: cleanUsername },
                progress: userProgressData
            });
        }

        if (action === 'save_progress') {
            const { username, password, progress } = body || {};
            if (!username || !password) {
                return res.status(400).json({ error: 'يرجى تسجيل الدخول أولاً' });
            }

            const cleanUsername = username.trim().toLowerCase();
            const usersIndex = await getMasterIndex();
            const userMeta = usersIndex[cleanUsername];

            if (userMeta) {
                try {
                    await fetch(`https://jsonblob.com/api/jsonBlob/${userMeta.blobId}`, {
                        method: 'PUT',
                        headers: { 
                            'Content-Type': 'application/json', 
                            'Accept': 'application/json',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QuduratApp'
                        },
                        body: JSON.stringify({
                            username: cleanUsername,
                            password: password,
                            progress: progress || {},
                            updated_at: new Date().toISOString()
                        })
                    });
                } catch (e) {
                    console.error("Cloud save error:", e);
                }
            }

            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ error: 'Action not specified' });

    } catch (err) {
        console.error('Auth Serverless API Error:', err);
        return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
}
