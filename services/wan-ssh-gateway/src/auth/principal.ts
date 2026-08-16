export interface Principal {
  kind: "development" | "firebase";
  id: string;
  uid: string;
  tenantId: string;
  email?: string;
  expiresAt?: number;
}