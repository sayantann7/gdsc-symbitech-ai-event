-- AlterTable
ALTER TABLE "Challenge" ADD COLUMN     "constraints" JSONB,
ADD COLUMN     "maxAttempts" INTEGER,
ADD COLUMN     "timeLimit" INTEGER;
