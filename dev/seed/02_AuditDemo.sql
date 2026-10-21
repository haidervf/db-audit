/* db-audit dev seed: AuditDemo (main target database, online bookshop domain: branches, members,
   loyalty cards with points, orders, shipments).
   DEV TOOLING ONLY. Run with: sqlcmd -C -b -I -x  (see dev/scripts/db-seed.sh).
   Idempotent: drops and recreates the database.

   Expected user objects (the integration tests assert these counts):
     tables     11  (dbo: Branch, Member, Member_Card, OrderLog, OrderLogArchive,
                     ShipmentLogs, ShipmentLogsArchive, AuditLog, Settings;
                     ops: JobWatermark, ErrorLog)
     views       2  (dbo.vw_MemberPoints, ops.vw_DailyOrderSummary)
     functions   2  (dbo.fn_CalcShipping scalar, dbo.tvf_CardOrders inline TVF)
     procedures 18  (16 regular incl. dbo.Synthetic_HardCases and dbo.usp_DailyOrderTotals (3-part name of this
                     database), + dbo.usp_Stale, + dbo.usp_Secret WITH ENCRYPTION)
     triggers    2  (DML dbo.trg_Member_Card_Audit, database DDL trg_ddl_NoOp)
     sequence    1  (dbo.seq_OrderRef)
*/
SET NOCOUNT ON;
GO
IF DB_ID(N'AuditDemo') IS NOT NULL
BEGIN
    ALTER DATABASE AuditDemo SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE AuditDemo;
END;
GO
CREATE DATABASE AuditDemo;
GO
USE AuditDemo;
GO
CREATE SCHEMA ops AUTHORIZATION dbo;
GO

/* ---------------------------------------------------------------- sequence + tables */
CREATE SEQUENCE dbo.seq_OrderRef AS bigint START WITH 100000 INCREMENT BY 1;
GO

CREATE TABLE dbo.Branch (
    BranchId   int IDENTITY(1,1) NOT NULL CONSTRAINT PK_Branch PRIMARY KEY,
    BranchCode varchar(20)       NOT NULL CONSTRAINT UQ_Branch_Code UNIQUE,
    Name       nvarchar(100)     NOT NULL,
    Region     nvarchar(50)      NULL,
    IsActive   bit               NOT NULL CONSTRAINT DF_Branch_IsActive DEFAULT (1),
    CreatedAt  datetime2(3)      NOT NULL CONSTRAINT DF_Branch_CreatedAt DEFAULT (SYSUTCDATETIME())
);

CREATE TABLE dbo.Member (
    MemberId     int IDENTITY(1,1) NOT NULL CONSTRAINT PK_Member PRIMARY KEY,
    BranchId     int               NULL CONSTRAINT FK_Member_Branch REFERENCES dbo.Branch (BranchId),
    ContactEmail varchar(100)      NOT NULL CONSTRAINT UQ_Member_Email UNIQUE,
    GivenName    nvarchar(50)      NOT NULL,
    FamilyName   nvarchar(50)      NOT NULL,
    FullName     AS (GivenName + N' ' + FamilyName) PERSISTED,
    LoyaltyTier  tinyint           NOT NULL CONSTRAINT DF_Member_Tier DEFAULT (0)
                                   CONSTRAINT CK_Member_Tier CHECK (LoyaltyTier BETWEEN 0 AND 3),
    Status       varchar(10)       NOT NULL CONSTRAINT DF_Member_Status DEFAULT ('ACTIVE'),
    LegacyFax    varchar(20)       NULL,      -- dropped after dbo.usp_Stale is created (makes it stale)
    CreatedAt    datetime2(3)      NOT NULL CONSTRAINT DF_Member_CreatedAt DEFAULT (SYSUTCDATETIME())
);

CREATE TABLE dbo.Member_Card (
    CardId          bigint IDENTITY(1000,1) NOT NULL CONSTRAINT PK_Member_Card PRIMARY KEY,
    MemberId        int            NOT NULL CONSTRAINT FK_Member_Card_Member REFERENCES dbo.Member (MemberId),
    CardCode        varchar(20)    NOT NULL CONSTRAINT UQ_Member_Card_Code UNIQUE,
    PointsScheme    char(3)        NOT NULL CONSTRAINT DF_Member_Card_Scheme DEFAULT ('STD'),
    PointsBalance   decimal(18,2)  NOT NULL CONSTRAINT DF_Member_Card_Points DEFAULT (0),
    ReservedPoints  decimal(18,2)  NOT NULL CONSTRAINT DF_Member_Card_Reserved DEFAULT (0),
    AvailablePoints AS (PointsBalance - ReservedPoints),
    ReservedUntil   datetime2(3)   NULL,
    Status          varchar(10)    NOT NULL CONSTRAINT DF_Member_Card_Status DEFAULT ('ACTIVE'),
    IssuedAt        datetime2(3)   NOT NULL CONSTRAINT DF_Member_Card_IssuedAt DEFAULT (SYSUTCDATETIME())
);

CREATE TABLE dbo.OrderLog (
    OrderId       bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_OrderLog PRIMARY KEY,
    CardId        bigint         NOT NULL CONSTRAINT FK_OrderLog_Card REFERENCES dbo.Member_Card (CardId),
    OrderRef      bigint         NOT NULL CONSTRAINT DF_OrderLog_OrderRef DEFAULT (NEXT VALUE FOR dbo.seq_OrderRef),
    OrderType     varchar(10)    NOT NULL,
    Amount        decimal(18,2)  NOT NULL,
    Shipping      decimal(18,2)  NOT NULL CONSTRAINT DF_OrderLog_Shipping DEFAULT (0),
    NetAmount     AS (Amount - Shipping) PERSISTED,
    Status        varchar(12)    NOT NULL CONSTRAINT DF_OrderLog_Status DEFAULT ('PENDING'),
    ChannelCode   varchar(10)    NULL,
    CreatedAt     datetime2(3)   NOT NULL CONSTRAINT DF_OrderLog_CreatedAt DEFAULT (SYSUTCDATETIME()),
    ProcessedAt   datetime2(3)   NULL
);
CREATE NONCLUSTERED INDEX IX_OrderLog_Card_Created
    ON dbo.OrderLog (CardId, CreatedAt DESC) INCLUDE (Amount, Status);

CREATE TABLE dbo.OrderLogArchive (
    OrderId       bigint         NOT NULL CONSTRAINT PK_OrderLogArchive PRIMARY KEY,
    CardId        bigint         NOT NULL,
    OrderRef      bigint         NOT NULL,
    OrderType     varchar(10)    NOT NULL,
    Amount        decimal(18,2)  NOT NULL,
    Shipping      decimal(18,2)  NOT NULL,
    Status        varchar(12)    NOT NULL,
    CreatedAt     datetime2(3)   NOT NULL,
    ArchivedAt    datetime2(3)   NOT NULL CONSTRAINT DF_OrderLogArchive_ArchivedAt DEFAULT (SYSUTCDATETIME())
);

CREATE TABLE dbo.ShipmentLogs (
    ShipmentId     bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_ShipmentLogs PRIMARY KEY,
    OrderId        bigint        NOT NULL CONSTRAINT FK_ShipmentLogs_Order REFERENCES dbo.OrderLog (OrderId),
    CarrierCode    varchar(10)   NOT NULL,
    TrackingNumber varchar(34)   NOT NULL,
    Amount         decimal(18,2) NOT NULL,
    Status         varchar(12)   NOT NULL CONSTRAINT DF_ShipmentLogs_Status DEFAULT ('SHIPPED'),
    ResultCode     varchar(10)   NULL,
    RequestedAt    datetime2(3)  NOT NULL CONSTRAINT DF_ShipmentLogs_RequestedAt DEFAULT (SYSUTCDATETIME()),
    CompletedAt    datetime2(3)  NULL
);
CREATE NONCLUSTERED INDEX IX_ShipmentLogs_Status
    ON dbo.ShipmentLogs (Status, RequestedAt) INCLUDE (CarrierCode, Amount);

CREATE TABLE dbo.ShipmentLogsArchive (
    ShipmentId     bigint        NOT NULL CONSTRAINT PK_ShipmentLogsArchive PRIMARY KEY,
    OrderId        bigint        NOT NULL,
    CarrierCode    varchar(10)   NOT NULL,
    TrackingNumber varchar(34)   NOT NULL,
    Amount         decimal(18,2) NOT NULL,
    Status         varchar(12)   NOT NULL,
    ResultCode     varchar(10)   NULL,
    RequestedAt    datetime2(3)  NOT NULL,
    CompletedAt    datetime2(3)  NULL,
    ArchivedAt     datetime2(3)  NOT NULL CONSTRAINT DF_ShipmentLogsArchive_ArchivedAt DEFAULT (SYSUTCDATETIME())
);

CREATE TABLE dbo.AuditLog (
    AuditId    bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_AuditLog PRIMARY KEY,
    EventType  varchar(30)  NOT NULL,
    EntityName sysname      NOT NULL,
    EntityId   bigint       NULL,
    Payload    nvarchar(max) NULL,
    CreatedAt  datetime2(3) NOT NULL CONSTRAINT DF_AuditLog_CreatedAt DEFAULT (SYSUTCDATETIME())
);

CREATE TABLE dbo.Settings (
    SettingKey   varchar(50)   NOT NULL CONSTRAINT PK_Settings PRIMARY KEY,
    SettingValue nvarchar(400) NOT NULL,
    UpdatedAt    datetime2(3)  NOT NULL CONSTRAINT DF_Settings_UpdatedAt DEFAULT (SYSUTCDATETIME())
);

CREATE TABLE ops.JobWatermark (
    JobName      nvarchar(128) NOT NULL CONSTRAINT PK_JobWatermark PRIMARY KEY,
    LastRunUtc   datetime2(3)  NULL,
    RowsAffected int           NULL
);

CREATE TABLE ops.ErrorLog (
    ErrorId      int IDENTITY(1,1) NOT NULL CONSTRAINT PK_ErrorLog PRIMARY KEY,
    ProcName     sysname        NOT NULL,
    ErrorNumber  int            NOT NULL,
    ErrorMessage nvarchar(4000) NULL,
    LoggedAt     datetime2(3)   NOT NULL CONSTRAINT DF_ErrorLog_LoggedAt DEFAULT (SYSUTCDATETIME())
);
GO

/* ---------------------------------------------------------------- data */
INSERT dbo.Branch (BranchCode, Name, Region) VALUES
 ('BR-NORTH-01', N'Northgate Branch', N'North'), ('BR-EAST-01', N'Riverside Branch', N'East'),
 ('BR-SOUTH-01', N'Hilltop Branch', N'South'), ('BR-WEST-01', N'Harbour Branch', N'West'),
 ('BR-CENTRAL-01', N'Old Town Branch', N'Central');

INSERT dbo.Member (BranchId, ContactEmail, GivenName, FamilyName, LoyaltyTier)
SELECT ((n - 1) % 5) + 1, CONCAT('member', n, '@example.com'), CONCAT(N'Given', n), CONCAT(N'Family', n), n % 4
FROM (SELECT TOP (20) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) AS x;

INSERT dbo.Member_Card (MemberId, CardCode, PointsBalance, ReservedPoints)
SELECT ((n - 1) % 20) + 1, CONCAT('MC', RIGHT(CONCAT('000000', n), 6)), n * 125.50, CASE WHEN n % 5 = 0 THEN 25 ELSE 0 END
FROM (SELECT TOP (25) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) AS x;

INSERT dbo.OrderLog (CardId, OrderType, Amount, Shipping, Status, ChannelCode, CreatedAt)
SELECT 1000 + ((n - 1) % 25),
       CASE n % 3 WHEN 0 THEN 'INSTORE' WHEN 1 THEN 'ONLINE' ELSE 'GIFT' END,
       (n % 50) * 3.25 + 1, CASE WHEN n % 3 = 1 THEN 0.50 ELSE 0 END,
       CASE WHEN n % 17 = 0 THEN 'FAILED' ELSE 'COMPLETED' END,
       CASE n % 2 WHEN 0 THEN 'KIOSK' ELSE 'APP' END,
       DATEADD(MINUTE, -n * 37, CAST('2026-10-13T12:00:00' AS datetime2(3)))
FROM (SELECT TOP (200) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) AS x;

INSERT dbo.ShipmentLogs (OrderId, CarrierCode, TrackingNumber, Amount, Status, ResultCode, RequestedAt)
SELECT OrderId, CASE OrderId % 3 WHEN 0 THEN 'POST' WHEN 1 THEN 'COURIER' ELSE 'PICKUP' END,
       CONCAT('TRK', OrderId), Amount, CASE WHEN OrderId % 7 = 0 THEN 'PENDING' ELSE 'DELIVERED' END, 'OK', CreatedAt
FROM dbo.OrderLog WHERE OrderType = 'ONLINE' AND OrderId <= 120;

INSERT dbo.OrderLogArchive (OrderId, CardId, OrderRef, OrderType, Amount, Shipping, Status, CreatedAt)
SELECT 900000 + n, 1000 + (n % 25), 50000 + n, 'INSTORE', n * 2.00, 0, 'COMPLETED', DATEADD(DAY, -200 - n, CAST('2026-10-01' AS datetime2(3)))
FROM (SELECT TOP (30) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) AS x;

INSERT dbo.ShipmentLogsArchive (ShipmentId, OrderId, CarrierCode, TrackingNumber, Amount, Status, RequestedAt, CompletedAt)
SELECT 800000 + n, 900000 + n, 'POST', CONCAT('OLD', n), n * 2.00, 'DELIVERED', DATEADD(DAY, -200 - n, CAST('2026-10-01' AS datetime2(3))), NULL
FROM (SELECT TOP (10) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) AS x;

INSERT dbo.AuditLog (EventType, EntityName, EntityId, Payload, CreatedAt)
SELECT 'SEED', N'Member', n, CONCAT(N'{"seed":', n, N'}'), DATEADD(DAY, -n, CAST('2026-10-13' AS datetime2(3)))
FROM (SELECT TOP (40) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) AS x;

INSERT dbo.Settings (SettingKey, SettingValue) VALUES
 ('SHIP_ONLINE_PCT', N'0.5'), ('SHIP_GIFT_FLAT', N'0.10'), ('ARCHIVE_DAYS', N'90'),
 ('RESERVE_HOURS', N'48'), ('CACHE_VERSION', N'1');

INSERT ops.JobWatermark (JobName, LastRunUtc, RowsAffected) VALUES
 (N'NightlyMaintenance', '2026-10-13T02:05:00', 120), (N'PurgeAuditAndSettings', '2026-10-14T00:15:00', 4);

INSERT ops.ErrorLog (ProcName, ErrorNumber, ErrorMessage) VALUES
 (N'usp_PlaceOrder', 547, N'FK violation (seed sample)');
GO

/* ---------------------------------------------------------------- views + functions */
CREATE VIEW dbo.vw_MemberPoints
AS
SELECT c.MemberId, c.FullName, c.ContactEmail, a.CardId, a.CardCode, a.PointsScheme,
       a.PointsBalance, a.ReservedPoints, a.AvailablePoints, br.BranchCode
FROM dbo.Member AS c
JOIN dbo.Member_Card AS a ON a.MemberId = c.MemberId
LEFT JOIN dbo.Branch AS br ON br.BranchId = c.BranchId
WHERE a.Status = 'ACTIVE';
GO

CREATE VIEW ops.vw_DailyOrderSummary
AS
SELECT CAST(t.CreatedAt AS date) AS OrderDate, t.OrderType, COUNT_BIG(*) AS OrderCount,
       SUM(t.Amount) AS TotalAmount, SUM(t.Shipping) AS TotalShipping
FROM dbo.OrderLog AS t
WHERE t.Status = 'COMPLETED'
GROUP BY CAST(t.CreatedAt AS date), t.OrderType;
GO

CREATE FUNCTION dbo.fn_CalcShipping (@Amount decimal(18,2), @OrderType varchar(10))
RETURNS decimal(18,2)
AS
BEGIN
    DECLARE @shipping decimal(18,2) = 0;
    IF @OrderType = 'ONLINE'
        SELECT @shipping = @Amount * CAST(SettingValue AS decimal(9,4)) / 100 FROM dbo.Settings WHERE SettingKey = 'SHIP_ONLINE_PCT';
    ELSE IF @OrderType = 'GIFT'
        SELECT @shipping = CAST(SettingValue AS decimal(9,4)) FROM dbo.Settings WHERE SettingKey = 'SHIP_GIFT_FLAT';
    RETURN @shipping;
END;
GO

CREATE FUNCTION dbo.tvf_CardOrders (@CardId bigint, @FromDate date)
RETURNS TABLE
AS
RETURN (
    SELECT t.OrderId, t.OrderRef, t.OrderType, t.Amount, t.Shipping, t.NetAmount, t.Status, t.CreatedAt
    FROM dbo.OrderLog AS t
    WHERE t.CardId = @CardId AND t.CreatedAt >= @FromDate
);
GO

/* ---------------------------------------------------------------- triggers */
CREATE TRIGGER dbo.trg_Member_Card_Audit ON dbo.Member_Card
AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    INSERT dbo.AuditLog (EventType, EntityName, EntityId, Payload)
    SELECT 'POINTS_CHANGE', N'Member_Card', i.CardId,
           CONCAT(N'{"old":', d.PointsBalance, N',"new":', i.PointsBalance, N'}')
    FROM inserted AS i
    JOIN deleted AS d ON d.CardId = i.CardId
    WHERE i.PointsBalance <> d.PointsBalance;
END;
GO

CREATE TRIGGER trg_ddl_NoOp ON DATABASE
FOR CREATE_TABLE
AS
BEGIN
    SET NOCOUNT ON;   -- intentionally empty: exercises database DDL trigger extraction
END;
GO

/* ---------------------------------------------------------------- procedures: leaf helpers */
CREATE PROCEDURE dbo.usp_LogError
    @ProcName     sysname,
    @ErrorNumber  int,
    @ErrorMessage nvarchar(4000)
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO ops.ErrorLog (ProcName, ErrorNumber, ErrorMessage)
    VALUES (@ProcName, @ErrorNumber, @ErrorMessage);
END;
GO

CREATE PROCEDURE dbo.usp_WriteAudit
    @EventType  varchar(30),
    @EntityName sysname,
    @EntityId   bigint = NULL,
    @Payload    nvarchar(max) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO dbo.AuditLog (EventType, EntityName, EntityId, Payload)
    VALUES (@EventType, @EntityName, @EntityId, @Payload);
END;
GO

/* ---------------------------------------------------------------- procedures: checkout chain
   dbo.usp_Checkout -> dbo.usp_PlaceOrder -> dbo.usp_WriteAudit / dbo.usp_LogError */
CREATE PROCEDURE dbo.usp_PlaceOrder
    @CardId    bigint,
    @Amount    decimal(18,2),
    @OrderType varchar(10),
    @OrderId   bigint OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    DECLARE @shipping decimal(18,2) = dbo.fn_CalcShipping(@Amount, @OrderType);
    DECLARE @ref bigint = NEXT VALUE FOR dbo.seq_OrderRef;
    BEGIN TRY
        BEGIN TRANSACTION;
        UPDATE dbo.Member_Card
           SET PointsBalance = PointsBalance + CASE WHEN @OrderType = 'GIFT' THEN 0 ELSE FLOOR(@Amount) END
         WHERE CardId = @CardId AND Status = 'ACTIVE';
        IF @@ROWCOUNT = 0 THROW 50010, N'Card not active', 1;
        INSERT INTO dbo.OrderLog (CardId, OrderRef, OrderType, Amount, Shipping, Status)
        VALUES (@CardId, @ref, @OrderType, @Amount, @shipping, 'COMPLETED');
        SET @OrderId = SCOPE_IDENTITY();
        EXEC dbo.usp_WriteAudit @EventType = 'ORDER_PLACED', @EntityName = N'OrderLog', @EntityId = @OrderId;
        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        DECLARE @num int = ERROR_NUMBER(), @msg nvarchar(4000) = ERROR_MESSAGE();
        EXEC dbo.usp_LogError @ProcName = N'usp_PlaceOrder', @ErrorNumber = @num, @ErrorMessage = @msg;
        THROW;
    END CATCH;
END;
GO

CREATE PROCEDURE dbo.usp_Checkout
    @MemberId  int,
    @Amount    decimal(18,2),
    @OrderType varchar(10) = 'GIFT'
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @RC int, @CardId bigint, @OrderId bigint;
    SELECT TOP (1) @CardId = a.CardId
    FROM dbo.Member_Card AS a
    WHERE a.MemberId = @MemberId AND a.Status = 'ACTIVE'
    ORDER BY a.PointsBalance DESC;
    EXEC @RC = dbo.usp_PlaceOrder @CardId = @CardId, @Amount = @Amount, @OrderType = @OrderType, @OrderId = @OrderId OUTPUT;
    IF @RC <> 0 RETURN @RC;
    SELECT @OrderId AS OrderId;
    RETURN 0;
END;
GO

/* ---------------------------------------------------------------- procedures: archiving (INSERT..SELECT, DELETE alias FROM, MERGE OUTPUT INTO, SELECT INTO #temp, 3-part name) */
CREATE PROCEDURE dbo.usp_ArchiveOrders
    @DaysOld int = 90
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @cutoff datetime2(3) = DATEADD(DAY, -@DaysOld, SYSUTCDATETIME());

    SELECT t.OrderId, t.CardId, t.OrderRef, t.OrderType, t.Amount, t.Shipping, t.Status, t.CreatedAt
    INTO #toArchive
    FROM dbo.OrderLog AS t
    WHERE t.CreatedAt < @cutoff AND t.Status IN ('COMPLETED', 'FAILED')
      AND NOT EXISTS (SELECT 1 FROM dbo.ShipmentLogs AS b WHERE b.OrderId = t.OrderId);

    INSERT INTO dbo.OrderLogArchive (OrderId, CardId, OrderRef, OrderType, Amount, Shipping, Status, CreatedAt)
    SELECT OrderId, CardId, OrderRef, OrderType, Amount, Shipping, Status, CreatedAt FROM #toArchive;

    DELETE t
    FROM dbo.OrderLog AS t
    JOIN #toArchive AS x ON x.OrderId = t.OrderId;

    INSERT INTO AuditArchive.dbo.OrderArchiveSummary (SummaryDate, OrderType, OrderCount, TotalAmount)
    SELECT CAST(CreatedAt AS date), OrderType, COUNT(*), SUM(Amount)
    FROM #toArchive
    GROUP BY CAST(CreatedAt AS date), OrderType;

    EXEC dbo.usp_WriteAudit @EventType = 'ARCHIVE', @EntityName = N'OrderLog', @Payload = N'archived';
    DROP TABLE #toArchive;
END;
GO

CREATE PROCEDURE dbo.usp_ArchiveShipments
    @DaysOld int = 90
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @cutoff datetime2(3) = DATEADD(DAY, -@DaysOld, SYSUTCDATETIME());

    MERGE dbo.ShipmentLogsArchive AS tgt
    USING (SELECT ShipmentId, OrderId, CarrierCode, TrackingNumber, Amount, Status, ResultCode, RequestedAt, CompletedAt
           FROM dbo.ShipmentLogs
           WHERE RequestedAt < @cutoff AND Status = 'DELIVERED') AS src
       ON tgt.ShipmentId = src.ShipmentId
    WHEN MATCHED THEN
        UPDATE SET tgt.Status = src.Status, tgt.CompletedAt = src.CompletedAt
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (ShipmentId, OrderId, CarrierCode, TrackingNumber, Amount, Status, ResultCode, RequestedAt, CompletedAt)
        VALUES (src.ShipmentId, src.OrderId, src.CarrierCode, src.TrackingNumber, src.Amount, src.Status, src.ResultCode, src.RequestedAt, src.CompletedAt)
    OUTPUT 'ARCHIVE_' + $action, N'ShipmentLogs', inserted.ShipmentId
      INTO dbo.AuditLog (EventType, EntityName, EntityId);

    DELETE b
    FROM dbo.ShipmentLogs AS b
    WHERE EXISTS (SELECT 1 FROM dbo.ShipmentLogsArchive AS a WHERE a.ShipmentId = b.ShipmentId);
END;
GO

/* ---------------------------------------------------------------- procedures: UPDATE alias..FROM JOIN, CTE, table variable */
CREATE PROCEDURE dbo.usp_SyncShipmentStatus
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @changed TABLE (ShipmentId bigint NOT NULL, NewStatus varchar(12) NOT NULL);

    ;WITH stuck AS (
        SELECT b.ShipmentId, b.OrderId
        FROM dbo.ShipmentLogs AS b
        WHERE b.Status = 'PENDING' AND b.RequestedAt < DATEADD(HOUR, -2, SYSUTCDATETIME())
    )
    UPDATE b
       SET b.Status = CASE WHEN t.Status = 'FAILED' THEN 'CANCELLED' ELSE 'DELIVERED' END,
           b.CompletedAt = SYSUTCDATETIME()
    OUTPUT inserted.ShipmentId, inserted.Status INTO @changed (ShipmentId, NewStatus)
    FROM dbo.ShipmentLogs AS b
    JOIN stuck AS s ON s.ShipmentId = b.ShipmentId
    JOIN dbo.OrderLog AS t ON t.OrderId = s.OrderId;

    SELECT c.ShipmentId, c.NewStatus FROM @changed AS c;
END;
GO

/* ---------------------------------------------------------------- procedures: cursor */
CREATE PROCEDURE dbo.usp_ExpireReservations
    @DryRun bit = 0
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @CardId bigint, @expired int = 0;
    DECLARE reserve_cursor CURSOR LOCAL FAST_FORWARD FOR
        SELECT CardId FROM dbo.Member_Card
        WHERE ReservedPoints > 0 AND ReservedUntil < SYSUTCDATETIME();
    OPEN reserve_cursor;
    FETCH NEXT FROM reserve_cursor INTO @CardId;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        IF @DryRun = 0
            UPDATE dbo.Member_Card SET ReservedPoints = 0, ReservedUntil = NULL WHERE CardId = @CardId;
        SET @expired += 1;
        FETCH NEXT FROM reserve_cursor INTO @CardId;
    END;
    CLOSE reserve_cursor;
    DEALLOCATE reserve_cursor;
    RETURN 0;
END;
GO

/* ---------------------------------------------------------------- procedures: dynamic SQL */
CREATE PROCEDURE dbo.usp_DynamicReport
    @TableName sysname,
    @TopN      int = 10
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @sql nvarchar(max) = N'SELECT TOP (' + CAST(@TopN AS nvarchar(10)) + N') * FROM dbo.' + QUOTENAME(@TableName);
    EXEC (@sql);
    SET @sql = N'SELECT COUNT_BIG(*) AS RowCnt FROM dbo.' + QUOTENAME(@TableName) + N' WHERE CreatedAt >= @since';
    EXEC sp_executesql @sql, N'@since datetime2(3)', @since = '2026-01-01';
END;
GO

/* ---------------------------------------------------------------- procedures: ## global temp + CTE */
CREATE PROCEDURE dbo.usp_StageBranchTotals
AS
BEGIN
    SET NOCOUNT ON;
    IF OBJECT_ID('tempdb..##BranchTotals') IS NOT NULL DROP TABLE ##BranchTotals;
    CREATE TABLE ##BranchTotals (BranchId int NOT NULL, OrderCount int NOT NULL, TotalAmount decimal(18,2) NOT NULL);

    ;WITH branchOrders AS (
        SELECT c.BranchId, t.Amount
        FROM dbo.OrderLog AS t
        JOIN dbo.Member_Card AS a ON a.CardId = t.CardId
        JOIN dbo.Member AS c ON c.MemberId = a.MemberId
        WHERE t.Status = 'COMPLETED'
    )
    INSERT INTO ##BranchTotals (BranchId, OrderCount, TotalAmount)
    SELECT BranchId, COUNT(*), SUM(Amount) FROM branchOrders GROUP BY BranchId;

    SELECT g.BranchId, br.BranchCode, g.OrderCount, g.TotalAmount
    FROM ##BranchTotals AS g JOIN dbo.Branch AS br ON br.BranchId = g.BranchId;
END;
GO

/* ---------------------------------------------------------------- procedures: ops schema */
CREATE PROCEDURE ops.usp_PurgeAuditLog
    @KeepDays int = 90
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @rows int;
    DELETE TOP (5000) FROM dbo.AuditLog
    WHERE CreatedAt < DATEADD(DAY, -@KeepDays, SYSUTCDATETIME());
    SET @rows = @@ROWCOUNT;
    UPDATE ops.JobWatermark SET LastRunUtc = SYSUTCDATETIME(), RowsAffected = @rows
    WHERE JobName = N'PurgeAuditLog';
END;
GO

CREATE PROCEDURE ops.usp_RefreshSettingsCache
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE dbo.Settings
       SET SettingValue = CAST(CAST(SettingValue AS int) + 1 AS nvarchar(400)), UpdatedAt = SYSUTCDATETIME()
     WHERE SettingKey = 'CACHE_VERSION';
    SELECT SettingKey, SettingValue FROM dbo.Settings;
END;
GO

/* ---------------------------------------------------------------- procedures: reads via view + inline TVF */
CREATE PROCEDURE dbo.usp_GetMemberHistory
    @CardId   bigint,
    @FromDate date = '2026-01-01'
AS
BEGIN
    SET NOCOUNT ON;
    SELECT b.FullName, b.CardCode, b.PointsBalance, b.AvailablePoints
    FROM dbo.vw_MemberPoints AS b
    WHERE b.CardId = @CardId;
    SELECT x.OrderId, x.OrderRef, x.OrderType, x.Amount, x.Shipping, x.NetAmount, x.Status, x.CreatedAt
    FROM dbo.tvf_CardOrders(@CardId, @FromDate) AS x
    ORDER BY x.CreatedAt DESC;
END;
GO

/* ---------------------------------------------------------------- procedures: 3-part name of THIS database
   [AuditDemo].[dbo].[OrderLog] is a local table (static analysis: sameDatabaseQualified). */
CREATE PROCEDURE dbo.usp_DailyOrderTotals
    @Days int = 7
AS
BEGIN
    SET NOCOUNT ON;
    SELECT CAST(t.CreatedAt AS date) AS OrderDate, t.OrderType, COUNT(*) AS OrderCount, SUM(t.Amount) AS TotalAmount
    FROM [AuditDemo].[dbo].[OrderLog] AS t
    WHERE t.CreatedAt >= DATEADD(DAY, -@Days, SYSUTCDATETIME())
    GROUP BY CAST(t.CreatedAt AS date), t.OrderType;
END;
GO

/* ---------------------------------------------------------------- procedures: top of the nightly chain
   dbo.usp_NightlyBatch -> dbo.usp_ArchiveOrders -> dbo.usp_WriteAudit */
CREATE PROCEDURE dbo.usp_NightlyBatch
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @rc int;
    EXEC @rc = dbo.usp_ArchiveOrders @DaysOld = 90;
    EXEC dbo.usp_ArchiveShipments @DaysOld = 90;
    EXEC ops.usp_PurgeAuditLog @KeepDays = 90;
    UPDATE ops.JobWatermark SET LastRunUtc = SYSUTCDATETIME() WHERE JobName = N'NightlyMaintenance';
END;
GO

/* ---------------------------------------------------------------- procedures: synthetic hard cases
   Adapted from the static-analysis test fixture SYNTHETIC_HardCases.sql. Most referenced objects deliberately do
   not exist (deferred name resolution) so the dependency views report unresolved / external refs.
   Omitted from the original: the OPENQUERY(LINKSRV, ...) line (CREATE fails with Msg 7202 when the
   linked server does not exist). Changed: the AuditLog DELETE uses CreatedAt (AuditLog exists here). */
/* SYNTHETIC test proc (not from corpus) /* nested comment with DELETE FROM dbo.Fake */ still comment */
CREATE PROCEDURE [dbo].[Synthetic_HardCases]
    @tbl SYSNAME,
    @id INT = 0
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @sql NVARCHAR(MAX) = N'SELECT * FROM dbo.NotReal WHERE x = ''it''''s'' -- not a comment';
    DECLARE @audit TABLE (Id INT, Act NVARCHAR(10));
    DECLARE @rc INT, @cid INT

    CREATE TABLE #Work (Id INT PRIMARY KEY, Amt MONEY)
    SELECT o.Id, o.Amt INTO #Snap FROM dbo.Orders o WITH (NOLOCK) WHERE o.Status = 'NEW'
    INSERT #Work (Id, Amt) SELECT Id, Amt FROM #Snap
    INSERT INTO ##GlobalStage VALUES (1, 2)

    ;WITH Dupes AS (
        SELECT Id, ROW_NUMBER() OVER (PARTITION BY Ref ORDER BY Id) rn FROM dbo.Reviews
    )
    DELETE FROM Dupes WHERE rn > 1

    MERGE dbo.StockLevels AS t
    USING (SELECT w.Id, w.Amt FROM #Work w JOIN OtherDb.dbo.Members c ON c.Id = w.Id) AS s
        ON t.Id = s.Id
    WHEN MATCHED THEN UPDATE SET t.Amt = t.Amt + s.Amt
    WHEN NOT MATCHED THEN INSERT (Id, Amt) VALUES (s.Id, s.Amt)
    OUTPUT $action, inserted.Id INTO dbo.MergeAudit (Act, Id);

    UPDATE a SET a.Flag = 1
    OUTPUT deleted.Id, 'U' INTO @audit
    FROM dbo.Shelves a INNER JOIN [LINKSRV].[RemoteDb].[dbo].[Quotas] l ON l.Id = a.Id
    WHERE a.Id = dbo.fn_ResolveId(@id)

    DELETE a FROM dbo.Shelves a JOIN #Work w ON w.Id = a.Id
    DELETE TOP (100) FROM dbo.AuditLog WHERE CreatedAt < DATEADD(day, -90, GETDATE())   -- adapted: AuditLog exists here, so the column must too
    TRUNCATE TABLE dbo.Staging

    DECLARE cur CURSOR LOCAL FAST_FORWARD FOR SELECT Id FROM dbo.Queue WITH (READPAST) WHERE Done = 0
    OPEN cur
    FETCH NEXT FROM cur INTO @cid
    WHILE @@FETCH_STATUS = 0
    BEGIN
        EXEC dbo.ProcessItem @ItemId = @cid, @Mode = 'FAST'
        EXEC @rc = ProcessItem2 @cid, 1
        IF @rc <> 0 BREAK
        FETCH NEXT FROM cur INTO @cid
    END
    CLOSE cur
    DEALLOCATE cur

    SELECT v.*, CASE WHEN v.X > 1 THEN 'END' ELSE 'BEGIN' END AS c
    FROM dbo.vw_Active v CROSS APPLY dbo.tvf_Split(v.Csv, ',') s, dbo.Lookup lk
    WHERE lk.Id = v.Id

    SET @sql = N'TRUNCATE TABLE dbo.' + QUOTENAME(@tbl)
    EXEC (@sql)
    EXEC sp_executesql @sql, N'@p INT', @p = 1
    EXEC LINKSRV.RemoteDb.dbo.RemoteProc @a = 1
    INSERT INTO @audit (Id, Act) EXEC dbo.GetAuditRows @id
    SELECT * FROM Archive..OldOrders
    DROP TABLE IF EXISTS #Work
    IF OBJECT_ID('tempdb..#Snap') IS NOT NULL DROP TABLE #Snap
    ELSE PRINT 'none'
END
GO

/* ---------------------------------------------------------------- stale + encrypted */
CREATE PROCEDURE dbo.usp_Stale
    @MemberId int
AS
BEGIN
    SET NOCOUNT ON;
    SELECT MemberId, ContactEmail, LegacyFax   -- LegacyFax is dropped below -> stale module
    FROM dbo.Member
    WHERE MemberId = @MemberId;
END;
GO
ALTER TABLE dbo.Member DROP COLUMN LegacyFax;
GO

CREATE PROCEDURE dbo.usp_Secret
WITH ENCRYPTION
AS
BEGIN
    SET NOCOUNT ON;
    SELECT SettingKey FROM dbo.Settings WHERE SettingKey LIKE 'SHIP%';
END;
GO
