// Die Logik wohnt seit W5c in `@saas-instant/auth-core` (geteilt mit dem
// Portal-Anmeldedienst): 32 Zufallsbytes als base64url, gespeichert wird nur
// der SHA-256-Hash. Diese Datei hält die bisherigen Importpfade stabil.
export { generateToken, hashToken } from '@saas-instant/auth-core';
