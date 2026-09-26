export type Visibility = "PRIVATE" | "SHARED" | "ORG";

export type LibItem = {
  id: string;
  kind: "ELEMENT" | "BLOCK";
  name: string;
  category: string;
  prefix: string;
  tags: string[];
  visibility: Visibility;
  status: string;
  revision: number;
  ownerName?: string;
  ownerId?: string;
  libraryName?: string;
  libraryId?: string;
  updatedAt?: string;
  description?: string;
  canEdit?: boolean;
  shared?: boolean;
  rejectReason?: string;
};

export type ElementDetail = {
  id: string;
  kind: "ELEMENT" | "BLOCK";
  name: string;
  category: string;
  prefix: string;
  revision: number;
  latestRevision: number;
  status: string;
  visibility: Visibility;
  content: string;
  meta: Record<string, string>;
  description: string;
  tags: string[];
  uuid: string;
  license: string | null;
  attribution: string | null;
  source: string | null;
  ownerId: string;
  ownerName?: string;
  approvedByName?: string;
  approvedAt?: string | null;
  approvedRevision?: number | null;
  rejectReason?: string | null;
  library: { id: string; name: string; scope: string; license: string | null; attribution: string | null; source: string | null };
  createdAt: string;
  updatedAt: string;
  access: { full: boolean; canEdit: boolean; canManage: boolean; canApprove: boolean; canDeprecate: boolean; isOwner: boolean };
};

export type LibraryInfo = {
  id: string;
  name: string;
  description: string;
  scope: string;
  source: string | null;
  license: string | null;
  attribution: string | null;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: string;
  count: number;
  mine: boolean;
  canWrite: boolean;
  canManage: boolean;
};

export type Revision = { revision: number; note: string; userName: string; createdAt: string };

/** Flags computed on the server page for the current user. */
export type LibUser = { id: string; name: string; isAdmin: boolean; isApprover: boolean; canPublish: boolean; requireApproval: boolean };
