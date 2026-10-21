/* db-audit dev seed: AuditArchive (second target database; also the target of a
   3-part cross-database reference from AuditDemo). DEV TOOLING ONLY.
   Run with: sqlcmd -C -b -I -x  (see dev/scripts/db-seed.sh). Idempotent: drops and recreates. */
SET NOCOUNT ON;
GO
IF DB_ID(N'AuditArchive') IS NOT NULL
BEGIN
    ALTER DATABASE AuditArchive SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE AuditArchive;
END;
GO
CREATE DATABASE AuditArchive;
GO
USE AuditArchive;
GO

CREATE TABLE dbo.ArchiveBatch (
    BatchId      int IDENTITY(1,1) NOT NULL CONSTRAINT PK_ArchiveBatch PRIMARY KEY,
    SourceTable  sysname           NOT NULL,
    RowsArchived int               NOT NULL CONSTRAINT DF_ArchiveBatch_Rows DEFAULT (0),
    StartedAt    datetime2(3)      NOT NULL CONSTRAINT DF_ArchiveBatch_Started DEFAULT (SYSUTCDATETIME()),
    FinishedAt   datetime2(3)      NULL
);

CREATE TABLE dbo.OrderArchiveSummary (
    SummaryDate  date          NOT NULL,
    OrderType    varchar(10)   NOT NULL,
    OrderCount   int           NOT NULL,
    TotalAmount  decimal(18,2) NOT NULL,
    BatchId      int           NULL CONSTRAINT FK_OAS_Batch REFERENCES dbo.ArchiveBatch (BatchId),
    CONSTRAINT PK_OrderArchiveSummary PRIMARY KEY (SummaryDate, OrderType)
);

CREATE TABLE dbo.ArchivedMember (
    MemberId     int           NOT NULL CONSTRAINT PK_ArchivedMember PRIMARY KEY,
    ContactEmail varchar(100)  NOT NULL,
    FullName     nvarchar(101) NULL,
    ClosedAt     datetime2(3)  NOT NULL
);
GO

INSERT dbo.ArchiveBatch (SourceTable, RowsArchived, StartedAt, FinishedAt) VALUES
 (N'OrderLog', 120, '2026-09-01T01:00:00', '2026-09-01T01:02:10'),
 (N'OrderLog',  95, '2026-10-01T01:00:00', '2026-10-01T01:01:48');
INSERT dbo.OrderArchiveSummary (SummaryDate, OrderType, OrderCount, TotalAmount, BatchId) VALUES
 ('2026-08-31', 'INSTORE', 60, 5400.00, 1), ('2026-08-31', 'ONLINE', 60, 3100.50, 1),
 ('2026-09-30', 'INSTORE', 50, 4200.00, 2), ('2026-09-30', 'GIFT', 45, 990.25, 2);
INSERT dbo.ArchivedMember (MemberId, ContactEmail, FullName, ClosedAt) VALUES
 (9001, 'old1@example.com', N'Old Member One', '2025-12-01T00:00:00'),
 (9002, 'old2@example.com', N'Old Member Two', '2026-01-15T00:00:00');
GO

CREATE PROCEDURE dbo.usp_CompactArchive
    @KeepMonths int = 24
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @cutoff date = DATEADD(MONTH, -@KeepMonths, CAST(SYSUTCDATETIME() AS date));
    DELETE FROM dbo.OrderArchiveSummary WHERE SummaryDate < @cutoff;
    UPDATE dbo.ArchiveBatch SET FinishedAt = SYSUTCDATETIME() WHERE FinishedAt IS NULL;
END;
GO

CREATE PROCEDURE dbo.usp_GetArchiveSummary
    @FromDate date,
    @ToDate   date
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.SummaryDate, s.OrderType, s.OrderCount, s.TotalAmount, b.SourceTable
    FROM dbo.OrderArchiveSummary AS s
    LEFT JOIN dbo.ArchiveBatch AS b ON b.BatchId = s.BatchId
    WHERE s.SummaryDate BETWEEN @FromDate AND @ToDate;
END;
GO
