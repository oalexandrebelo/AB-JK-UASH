/** Public, explicitly allowlisted business data. Never expose customer or operational rows. */
export async function publicJkProfile(db) {
  const services = await db.prepare('SELECT id,name,price_cents,duration_minutes FROM services WHERE active=1 ORDER BY name,id LIMIT 100').all();
  return {
    name: 'Lava Rápido JK',
    product: 'AB-JK-UASH',
    instagram: 'https://www.instagram.com/lavar.apidojk/',
    location: {city: 'Rio Verde', state: 'GO'},
    services: services.map(row => ({id: row.id, name: row.name, priceCents: row.price_cents, durationMinutes: row.duration_minutes})),
    acceptingOnlineBookings: false,
  };
}
