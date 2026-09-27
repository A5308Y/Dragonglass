module Gtd.Command.Checklists exposing (Command(..), encode)

{-| Commands owned by the Checklists surface.
-}

import Gtd.Checklist exposing (MarkState)
import Gtd.Command as Base
import Json.Encode as Encode


type Command
    = StartRun String
    | ShowRun (Maybe String)
    | MarkItem { runId : String, key : String, state : MarkState }
    | FinishRun String
    | DiscardRun String
    | Capture { path : String, text : String }
    | StartPomodoro String
    | OpenNote String


encode : Command -> Encode.Value
encode command =
    Base.encode
        (case command of
            StartRun path ->
                Base.StartChecklistRun path

            ShowRun maybeRunId ->
                Base.ShowChecklistRun maybeRunId

            MarkItem fields ->
                Base.MarkChecklistItem fields

            FinishRun runId ->
                Base.FinishChecklistRun runId

            DiscardRun runId ->
                Base.DiscardChecklistRun runId

            Capture fields ->
                Base.CaptureFromChecklist fields

            StartPomodoro path ->
                Base.OpenChecklistPomodoro path

            OpenNote path ->
                Base.OpenFile path
        )
