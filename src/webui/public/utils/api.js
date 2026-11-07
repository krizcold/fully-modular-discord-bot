// API helper for same-origin requests. Auth is handled at the deployment boundary
// (a gateway when managed, or the localhost bind when standalone), not by a URL param.

// A non-2xx answer: the Error carries the status and the parsed body, for callers that decide on a field.
function httpError(res, json) {
  return Object.assign(new Error(json.error || json.message || `HTTP ${res.status}`), { status: res.status, body: json });
}

const api = {
  async get(endpoint) {
    const res = await fetch(`/api${endpoint}`);

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
      throw httpError(res, json);
    }
    return json;
  },
  async post(endpoint, data = {}) {
    const res = await fetch(`/api${endpoint}`, {
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
      throw httpError(res, json);
    }
    return json;
  },
  async put(endpoint, data = {}) {
    const res = await fetch(`/api${endpoint}`, {
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
      throw httpError(res, json);
    }
    return json;
  },
  async delete(endpoint) {
    const res = await fetch(`/api${endpoint}`, {
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
      throw httpError(res, json);
    }
    return json;
  }
};
