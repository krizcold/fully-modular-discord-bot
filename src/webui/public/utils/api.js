// API helper for authenticated requests
const urlParams = new URLSearchParams(window.location.search);
const authHash = urlParams.get('hash') || '';

const api = {
  async get(endpoint) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `/api${endpoint}${separator}hash=${authHash}`;
    const res = await fetch(url);

    // Clone response so we can read it as text if JSON parsing fails
    const resClone = res.clone();

    let json;
    try {
      json = await res.json();
    } catch (parseError) {
      // Response wasn't JSON (likely HTML error page)
      const text = await resClone.text();
      throw new Error(`Server returned non-JSON response (${res.status}): ${text.substring(0, 100)}`);
    }

    if (!res.ok) {
      throw new Error(json.error || json.message || `HTTP ${res.status}`);
    }
    return json;
  },
  async post(endpoint, data = {}) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `/api${endpoint}${separator}hash=${authHash}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    // Clone response so we can read it as text if JSON parsing fails
    const resClone = res.clone();

    let json;
    try {
      json = await res.json();
    } catch (parseError) {
      // Response wasn't JSON (likely HTML error page)
      const text = await resClone.text();
      throw new Error(`Server returned non-JSON response (${res.status}): ${text.substring(0, 100)}`);
    }

    if (!res.ok) {
      throw new Error(json.error || json.message || `HTTP ${res.status}`);
    }
    return json;
  },
  async put(endpoint, data = {}) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `/api${endpoint}${separator}hash=${authHash}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    const resClone = res.clone();

    let json;
    try {
      json = await res.json();
    } catch (parseError) {
      const text = await resClone.text();
      throw new Error(`Server returned non-JSON response (${res.status}): ${text.substring(0, 100)}`);
    }

    if (!res.ok) {
      throw new Error(json.error || json.message || `HTTP ${res.status}`);
    }
    return json;
  },
  async delete(endpoint) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `/api${endpoint}${separator}hash=${authHash}`;
    const res = await fetch(url, {
      method: 'DELETE'
    });

    const resClone = res.clone();

    let json;
    try {
      json = await res.json();
    } catch (parseError) {
      const text = await resClone.text();
      throw new Error(`Server returned non-JSON response (${res.status}): ${text.substring(0, 100)}`);
    }

    if (!res.ok) {
      throw new Error(json.error || json.message || `HTTP ${res.status}`);
    }
    return json;
  }
};
