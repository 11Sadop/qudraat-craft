// Vercel Serverless Function for Qudurat-Craft Cloud Sync (/api/sync.js)
// Proxies storage requests server-side to bypass browser CORS & Mobile Safari issues

export default async function handler(req, res) {
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
        if (req.method === 'POST') {
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            
            // Generate a friendly 6-digit PIN
            const pinCode = Math.floor(100000 + Math.random() * 900000).toString();
            const topic = `qudurat_sync_${pinCode}`;
            
            // Publish to ntfy server-side
            await fetch(`https://ntfy.sh/${topic}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            // Also publish to jsonblob for redundancy
            try {
                await fetch('https://jsonblob.com/api/jsonBlob', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
            } catch (e) {}

            return res.status(200).json({ syncCode: pinCode, success: true });
        }

        if (req.method === 'GET') {
            const { code } = req.query;
            if (!code) return res.status(400).json({ error: 'Missing sync code' });

            const cleanCode = code.trim();
            
            // 1. Try ntfy server-side
            try {
                const topic = `qudurat_sync_${cleanCode}`;
                const ntfyRes = await fetch(`https://ntfy.sh/${topic}/json?poll=1`);
                if (ntfyRes.ok) {
                    const text = await ntfyRes.text();
                    if (text.trim()) {
                        const lines = text.trim().split('\n').filter(l => l.trim().length > 0);
                        const messageEvents = lines
                            .map(l => { try { return JSON.parse(l); } catch(e) { return null; } })
                            .filter(obj => obj && obj.event === 'message' && obj.message);

                        if (messageEvents.length > 0) {
                            const lastMsgObj = messageEvents[messageEvents.length - 1];
                            const cloudPayload = JSON.parse(lastMsgObj.message);
                            return res.status(200).json({ data: cloudPayload, success: true });
                        }
                    }
                }
            } catch (e) {}

            // 2. Try jsonblob fallback server-side
            try {
                const jsonblobRes = await fetch(`https://jsonblob.com/api/jsonBlob/${cleanCode}`, {
                    headers: { 'Accept': 'application/json' }
                });
                if (jsonblobRes.ok) {
                    const data = await jsonblobRes.json();
                    return res.status(200).json({ data, success: true });
                }
            } catch (e) {}

            return res.status(404).json({ error: 'لم يتم العثور على بيانات مرتبطة بهذا الكود' });
        }

        if (req.method === 'PUT') {
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            const { syncCode, progress } = body || {};
            if (!syncCode) return res.status(400).json({ error: 'Missing syncCode' });

            const cleanCode = syncCode.trim();
            const topic = `qudurat_sync_${cleanCode}`;

            // Sync to ntfy server-side
            await fetch(`https://ntfy.sh/${topic}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ progress, updated_at: new Date().toISOString() })
            });

            // Sync to jsonblob fallback
            try {
                await fetch(`https://jsonblob.com/api/jsonBlob/${cleanCode}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ progress, updated_at: new Date().toISOString() })
                });
            } catch (e) {}

            return res.status(200).json({ success: true });
        }

        return res.status(405).json({ error: 'Method not allowed' });

    } catch (err) {
        console.error('Serverless Sync API Error:', err);
        return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
}
