import { Router, type IRouter } from "express";
import healthRouter from "./health";
import seatingRouter from "./seating";

const router: IRouter = Router();

router.use(healthRouter);
router.use(seatingRouter);

export default router;
