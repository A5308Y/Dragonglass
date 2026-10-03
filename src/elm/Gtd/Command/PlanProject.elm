module Gtd.Command.PlanProject exposing (Command(..), encode)

{-| Commands owned by the Plan Project dialog.
-}

import Gtd.Command as Base exposing (PlanItem)
import Json.Encode as Encode


type Command
    = SavePlan { projectId : String, purpose : String, desiredOutcome : String, items : List PlanItem }
    | AddAction { projectId : String, title : String, context : String }
    | Delegate String
    | Close


encode : Command -> Encode.Value
encode command =
    Base.encode
        (case command of
            SavePlan plan ->
                Base.SaveProjectPlan plan

            AddAction fields ->
                Base.AddPlanAction fields

            Delegate projectId ->
                Base.DelegatePlanProject projectId

            Close ->
                Base.ClosePlan
        )
