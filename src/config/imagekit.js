const crypto = require("crypto");

// ImageKit endpoints and defaults. Kept here so the route and any future
// caller share one source of truth.
const UPLOAD_URL = "https://upload.imagekit.io/api/v1/files/upload";
const DELETE_BASE_URL = "https://api.imagekit.io/v1/files";
const DEFAULT_FOLDER = "/maintainiq/assets";

// Signatures are valid for 30 minutes. ImageKit requires an expiry of less
// than one hour in the future.
const AUTH_EXPIRE_SECONDS = 30 * 60;

// Reads the ImageKit configuration from the environment. Values are never
// logged; only the presence of the keys is ever reported.
const getConfig = () => ({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY || "",
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY || "",
  urlEndpoint: (process.env.IMAGEKIT_URL_ENDPOINT || "").replace(/\/+$/, ""),
  folder: process.env.IMAGEKIT_UPLOAD_FOLDER || DEFAULT_FOLDER,
});

// True only when every value needed for client-side uploads is present. Lets
// callers fail with a clear 503 instead of sending a broken signature.
const isConfigured = () => {
  const { publicKey, privateKey, urlEndpoint } = getConfig();
  return Boolean(publicKey && privateKey && urlEndpoint);
};

// HMAC-SHA1 digest (lowercase hex) of token + expire, keyed by the private API
// key. This matches ImageKit's documented client-side upload signature.
const sign = (token, expire, privateKey) =>
  crypto
    .createHmac("sha1", privateKey)
    .update(`${token}${expire}`)
    .digest("hex");

// Builds the one-time parameters the browser needs to upload a file directly
// to ImageKit. The private key is used to sign but is never included.
const getAuthParams = () => {
  const { publicKey, privateKey, urlEndpoint, folder } = getConfig();
  const token = crypto.randomUUID();
  const expire = Math.floor(Date.now() / 1000) + AUTH_EXPIRE_SECONDS;
  return {
    token,
    expire,
    signature: sign(token, expire, privateKey),
    publicKey,
    urlEndpoint,
    folder,
    uploadUrl: UPLOAD_URL,
  };
};

// Deletes an uploaded file using the private key (HTTP Basic with the private
// key as the username and an empty password). Never throws: returns
// { ok, status } so callers can treat cleanup as best-effort.
const deleteFile = async (fileId) => {
  const { privateKey } = getConfig();
  if (!privateKey || !fileId) {
    return { ok: false, status: 0 };
  }

  const authorization =
    "Basic " + Buffer.from(`${privateKey}:`).toString("base64");

  try {
    const response = await fetch(
      `${DELETE_BASE_URL}/${encodeURIComponent(fileId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: authorization,
          Accept: "application/json",
        },
      }
    );
    return { ok: response.status === 204, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error };
  }
};

module.exports = {
  UPLOAD_URL,
  DEFAULT_FOLDER,
  getConfig,
  isConfigured,
  getAuthParams,
  sign,
  deleteFile,
};
