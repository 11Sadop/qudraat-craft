// Vercel Serverless Function for Qudurat-Craft Persistent User Accounts (/api/auth.js)

const MASTER_INDEX_BLOB_ID = "019f7232-93d8-7e07-bfd4-40cd49cd6c4f";

async function getMasterIndex() {
    try {
        const res = await fetch(`https://jsonblob.com/api/jsonBlob/${MASTER_INDEX_BLOB_ID}`, {
            headers: { 'Accept': 'application/json' }
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
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
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

        if (action === 'register') {
            const { username, password, progress } = body || {};
            if (!username || !password) {
                return res.status(400).json({ error: 'يرجى كتابة اسم المستخدم وكلمة المرور' });
            }
            const cleanUsername = username.trim().toLowerCase();
            const usersIndex = await getMasterIndex();

            if (usersIndex[cleanUsername]) {
                return res.status(400).json({ error: 'اسم المستخدم مسجل بالفعل. يرجى اختيار اسم جديد أو تسجيل الدخول.' });
            }

            // Create dedicated user progress blob
            const userPayload = {
                username: cleanUsername,
                password: password,
                progress: progress || {},
                created_at: new Date().toISOString()
            };

            const createRes = await fetch('https://jsonblob.com/api/jsonBlob', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify(userPayload)
            });

            if (!createRes.ok) {
                return res.status(500).json({ error: 'تعذر إنشاء الحساب في السحابة. حاول لاحقاً.' });
            }

            const rawLocation = createRes.headers.get('Location') || createRes.headers.get('x-jsonblob-id');
            const userBlobId = rawLocation ? rawLocation.split('/').pop() : null;

            if (!userBlobId) {
                return res.status(500).json({ error: 'تعذر حفظ بيانات الحساب.' });
            }

            // Update master index
            usersIndex[cleanUsername] = {
                password: password,
                blobId: userBlobId
            };
            await updateMasterIndex(usersIndex);

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
            const usersIndex = await getMasterIndex();
            const userMeta = usersIndex[cleanUsername];

            if (!userMeta) {
                return res.status(404).json({ error: 'اسم المستخدم غير موجود. يرجى التثبت من الاسم أو إنشاء حساب جديد' });
            }

            if (userMeta.password !== password) {
                return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
            }

            // Fetch dedicated user progress
            const userBlobRes = await fetch(`https://jsonblob.com/api/jsonBlob/${userMeta.blobId}`, {
                headers: { 'Accept': 'application/json' }
            });

            let userProgressData = {};
            if (userBlobRes.ok) {
                const userData = await userBlobRes.json();
                userProgressData = userData.progress || {};
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

            if (!userMeta || userMeta.password !== password) {
                return res.status(401).json({ error: 'بيانات الحساب غير صالحة' });
            }

            // Update user blob
            await fetch(`https://jsonblob.com/api/jsonBlob/${userMeta.blobId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({
                    username: cleanUsername,
                    password: password,
                    progress: progress || {},
                    updated_at: new Date().toISOString()
                })
            });

            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ error: 'Action not specified' });

    } catch (err) {
        console.error('Auth Serverless API Error:', err);
        return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
}
