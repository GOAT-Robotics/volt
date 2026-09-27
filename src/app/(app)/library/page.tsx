import { Suspense } from "react";
import { requireCtx } from "@/lib/session";
import { canPublish, isAdmin, isApprover } from "@/lib/library/access";
import { LibraryBrowser } from "@/library-editor/browser/LibraryBrowser";
import type { LibUser } from "@/library-editor/types";

export const metadata = { title: "Library" };

export default async function LibraryPage() {
  const ctx = await requireCtx();
  const user: LibUser = { id: ctx.user.id, name: ctx.user.name, isAdmin: isAdmin(ctx), isApprover: isApprover(ctx), canPublish: canPublish(ctx), requireApproval: ctx.settings.library.requireApprovalForOrg };
  return (
    <div className="h-full">
      <Suspense>
        <LibraryBrowser user={user} />
      </Suspense>
    </div>
  );
}
