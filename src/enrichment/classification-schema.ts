import { z } from "zod";
import { CLASSIFICATION_SCHEMA_VERSION } from "../config/lab-config";

export const DOCUMENT_TYPES = ["invoice", "contract", "report", "email", "meeting_notes", "other"] as const;

export const modelClassificationSchema = z.object({
  doc_type: z.enum(DOCUMENT_TYPES),
  language: z.string().min(2).max(35),
  pii_present: z.boolean(),
  summary: z.string().min(1).max(500),
});

export const classificationSchema = modelClassificationSchema.extend({
  schema_version: z.literal(CLASSIFICATION_SCHEMA_VERSION),
  generated_by: z.string().min(1),
  generated_at: z.iso.datetime(),
  review_required: z.boolean(),
});

export type ModelClassification = z.infer<typeof modelClassificationSchema>;
export type Classification = z.infer<typeof classificationSchema>;

export interface ClassificationProvenance {
  generatedBy: string;
  generatedAt: Date;
}

/**
 * Labels produced by a model are proposals: review_required stays true until a human or
 * a downstream policy clears it.
 */
export function toClassification(model: ModelClassification, provenance: ClassificationProvenance): Classification {
  return classificationSchema.parse({
    ...model,
    schema_version: CLASSIFICATION_SCHEMA_VERSION,
    generated_by: provenance.generatedBy,
    generated_at: provenance.generatedAt.toISOString(),
    review_required: true,
  });
}
