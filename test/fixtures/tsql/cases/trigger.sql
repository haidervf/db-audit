CREATE TRIGGER [dbo].[trg_Orders_Audit] ON [dbo].[Orders]
WITH EXECUTE AS OWNER
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF UPDATE(Status)
        INSERT INTO dbo.OrderAudit (OrderId, OldStatus, NewStatus)
        SELECT i.Id, d.Status, i.Status
        FROM inserted i
        JOIN deleted d ON d.Id = i.Id;
END
