import { createClient, type Customer, type User } from '../src/index.js';

// Bundle this module with your application. Credentials come from its login UI.
const client = createClient({ baseUrl: window.location.origin, mode: 'browser' });

export async function restoreSession(): Promise<User | null> {
  return (await client.api.getSession()).user;
}

export async function signIn(email: string, password: string): Promise<User> {
  return (await client.api.login({ body: { email, password } })).user;
}

export async function loadActiveCustomers(): Promise<Customer[]> {
  return (await client.api.listCustomers({ query: { active: 'true', limit: 50 } })).items;
}

export async function signOut(): Promise<void> {
  await client.api.logout({ body: {} });
}
