/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `Team` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `password` to the `Team` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "password" TEXT NOT NULL,
ADD COLUMN     "tokensRound1" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN     "tokensRound2" INTEGER NOT NULL DEFAULT 300,
ADD COLUMN     "tokensRound3" INTEGER NOT NULL DEFAULT 200;

-- CreateIndex
CREATE UNIQUE INDEX "Team_name_key" ON "Team"("name");
