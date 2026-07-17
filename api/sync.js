// Vercel Serverless Function for Qudurat-Craft Cloud Sync
// Bypasses browser CORS restrictions by fetching jsonblob server-side

export default async function handler(req, res) {
    // Set CORS Headers for all client requests
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        if (req.method === 'POST') {
            // Create new cloud sync record
            const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            const upstreamRes = await fetch('https://jsonblob.com/api/jsonBlob', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!upstreamRes.ok) {
                return res.status(upstreamRes.status).json({ error: 'Upstream cloud error' });
            }

            const blobId = upstreamRes.headers.get('x-jsonblob-id') || 
                           (upstreamRes.headers.get('location') || '').split('/').pop();

            if (!blobId) {
                return res.status(500).json({ error: 'Failed to extract sync code' });
            }

            return res.status(200).json({ syncCode: blobId, success: true });
        }

        if (req.method === 'GET') {
            // Retrieve progress by sync code
            const { code } = req.query;
            if (!code) return res.status(400).json({ error: 'Missing sync code' });

            const upstreamRes = await fetch(`https://jsonblob.com/api/jsonBlob/${code}`, {
                headers: { 'Accept': 'application/json' }
            });

            if (!upstreamRes.ok) {
                return res.status(upstreamRes.status).json({ error: 'Sync code not found or expired' });
            }

            const data = await upstreamRes.json();
            return res.status(200).json({ data, success: true });
        }

        if (req.method === 'PUT') {
            // Update existing progress record
            const { syncCode, progress } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            if (!syncCode) return res.status(400).json({ error: 'Missing syncCode' });

            const upstreamRes = await fetch(`https://jsonblob.com/api/jsonBlob/${syncCode}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ progress, updated_at: new Date().toISOString() })
            });

            if (!upstreamRes.ok) {
                return res.status(upstreamRes.status).json({ error: 'Failed to update cloud progress' });
            }

            return res.status(200).json({ success: true });
        }

        return res.status(405).json({ error: 'Method not allowed' });

    } catch (err) {
        console.error('Serverless Sync Error:', err);
        return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
}
