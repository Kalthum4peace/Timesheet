import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isProtectedRoute =
    request.nextUrl.pathname.startsWith("/timesheet") ||
    request.nextUrl.pathname.startsWith("/approvals") ||
    request.nextUrl.pathname.startsWith("/returned-items") ||
    request.nextUrl.pathname.startsWith("/all-timesheets") ||
    request.nextUrl.pathname.startsWith("/roster") ||
    request.nextUrl.pathname.startsWith("/admin") ||
    request.nextUrl.pathname.startsWith("/change-password");

  if (!user && isProtectedRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Mandatory first-login password change. While profiles.must_change_password
  // is true the ONLY page a signed-in user can reach is /change-password
  // (plus /login, so they can sign out and back in). Everything else — deep
  // links, the root route, every protected page — bounces there.
  //
  // Reads the caller's own profile row through their own session (own-row
  // SELECT is allowed by RLS). If that read fails we let the request through
  // rather than lock everyone out on a transient error: this is an app-level
  // gate, not a database boundary (see the migration comment).
  if (user) {
    const path = request.nextUrl.pathname;
    if (!path.startsWith("/change-password") && !path.startsWith("/login")) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("must_change_password")
        .eq("id", user.id)
        .maybeSingle();
      if (profile?.must_change_password) {
        const url = request.nextUrl.clone();
        url.pathname = "/change-password";
        url.search = "";
        return NextResponse.redirect(url);
      }
    }
  }

  return supabaseResponse;
}
