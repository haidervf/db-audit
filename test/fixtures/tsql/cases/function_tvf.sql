CREATE FUNCTION dbo.tvf_ActiveOrders (@MemberId INT, @Since DATE = NULL)
RETURNS TABLE
WITH SCHEMABINDING
AS
RETURN
(
    SELECT o.Id, o.Amt
    FROM dbo.Orders o
    WHERE o.MemberId = @MemberId AND dbo.fn_IsActive(o.Status) = 1
);
