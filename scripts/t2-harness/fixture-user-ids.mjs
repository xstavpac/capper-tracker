// Pure constants, no side effects - split out from fixtures.ts specifically
// so capture-output.ts can import the fixture user identifiers WITHOUT
// re-triggering fixtures.ts's top-level main() (which seeds/wipes data) as
// an import side effect. fixtures.ts re-exports these for its own use.
export const FIXTURE_USER_A_SUPABASE_ID = "t2-fixture-user-a";
export const FIXTURE_USER_B_SUPABASE_ID = "t2-fixture-user-b";
