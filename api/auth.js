// Vercel Serverless Function for User Authentication & Cloud Data Persistence (/api/auth.js)

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
            const topic = `qudurat_user_${cleanUsername}`;

            // Check if user already exists on cloud
            try {
                const checkRes = await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=all`);
                if (checkRes.ok) {
                    const text = await checkRes.text();
                    if (text.trim()) {
                        const lines = text.trim().split('\n').filter(l => l.trim().length > 0);
                        const messageEvents = lines
                            .map(l => { try { return JSON.parse(l); } catch(e) { return null; } })
                            .filter(obj => obj && obj.event === 'message' && obj.message);

                        if (messageEvents.length > 0) {
                            const existingData = JSON.parse(messageEvents[messageEvents.length - 1].message);
                            if (existingData.username === cleanUsername && existingData.password !== password) {
                                return res.status(400).json({ error: 'اسم المستخدم مسجل بالفعل بحساب آخر. يرجى اختيار اسم جديد أو تسجيل الدخول' });
                            }
                        }
                    }
                }
            } catch (e) {}

            // Save new user account and initial progress
            const userData = {
                username: cleanUsername,
                password: password,
                progress: progress || {},
                created_at: new Date().toISOString()
            };

            await fetch(`https://ntfy.sh/${topic}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(userData)
            });

            return res.status(200).json({
                success: true,
                user: { username: cleanUsername },
                progress: userData.progress
            });
        }

        if (action === 'login') {
            const { username, password } = body || {};
            if (!username || !password) {
                return res.status(400).json({ error: 'يرجى كتابة اسم المستخدم وكلمة المرور' });
            }

            const cleanUsername = username.trim().toLowerCase();
            const topic = `qudurat_user_${cleanUsername}`;

            const ntfyRes = await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=all`);
            if (!ntfyRes.ok) {
                return res.status(400).json({ error: 'تعذر الاتصال بقاعدة البيانات. حاول لاحقاً.' });
            }

            const text = await ntfyRes.text();
            if (!text.trim()) {
                return res.status(404).json({ error: 'اسم المستخدم غير موجود. يرجى التثبت من الاسم أو إنشاء حساب جديد' });
            }

            const lines = text.trim().split('\n').filter(l => l.trim().length > 0);
            const messageEvents = lines
                .map(l => { try { return JSON.parse(l); } catch(e) { return null; } })
                .filter(obj => obj && obj.event === 'message' && obj.message);

            if (messageEvents.length === 0) {
                return res.status(404).json({ error: 'اسم المستخدم غير موجود. يرجى التثبت من الاسم أو إنشاء حساب جديد' });
            }

            const lastMsgObj = messageEvents[messageEvents.length - 1];
            const userData = JSON.parse(lastMsgObj.message);

            if (userData.password !== password) {
                return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
            }

            return res.status(200).json({
                success: true,
                user: { username: cleanUsername },
                progress: userData.progress || {}
            });
        }

        if (action === 'save_progress') {
            const { username, password, progress } = body || {};
            if (!username || !password) {
                return res.status(400).json({ error: 'يرجى تسجيل الدخول أولاً' });
            }

            const cleanUsername = username.trim().toLowerCase();
            const topic = `qudurat_user_${cleanUsername}`;

            const userData = {
                username: cleanUsername,
                password: password,
                progress: progress || {},
                updated_at: new Date().toISOString()
            };

            await fetch(`https://ntfy.sh/${topic}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(userData)
            });

            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ error: 'Action not specified' });

    } catch (err) {
        console.error('Auth Serverless API Error:', err);
        return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
}
