import { Prisma, type AuditOperation, type AuditSource } from "@prisma/client";

type AuditWriter = Pick<Prisma.TransactionClient, "auditEvent">;

export type AuditActor = { id: string; email: string; organizationId?: string } | null;

export async function recordAuditEvent(
  writer: AuditWriter,
  input: {
    actor: AuditActor;
    organizationId?: string;
    operation: AuditOperation;
    entity: string;
    entityId: string;
    source?: AuditSource;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
  }
) {
  return writer.auditEvent.create({
    data: {
      actorUserId: input.actor?.id ?? null,
      organizationId: input.organizationId ?? input.actor?.organizationId ?? (() => { throw new Error("organizationId is required for audit events"); })(),
      actorEmail: input.actor?.email ?? null,
      source: input.source ?? (input.actor ? "APP" : "SYSTEM"),
      operation: input.operation,
      entity: input.entity,
      entityId: input.entityId,
      ...(input.before !== undefined ? { before: input.before } : {}),
      ...(input.after !== undefined ? { after: input.after } : {})
    }
  });
}
