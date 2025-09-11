// src/api/realtime-sse/services/targets.ts
export default ({ strapi }) => ({
  async listUserIdsByRoleNames(names: string[]): Promise<number[]> {
    // Normalize desired role names to lowercase once
    const want = new Set(names.map(n => String(n).toLowerCase()));

    // Fetch users WITH their role names, then filter in JS (robust to case/variants)
    const users = await strapi.db.query('plugin::users-permissions.user').findMany({
      select: ['id'],
      populate: { role: { select: ['name'] } },
    });

    return users
      .filter(u => u?.role?.name && want.has(String(u.role.name).toLowerCase()))
      .map(u => u.id);
  },
});
